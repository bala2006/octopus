/**
 * File tools. Reads are free. Writes are versioned (every change can be reverted from Changes) and guarded: creating
 * files, and editing files the team created, run straight away; editing your existing files asks first in "ask" mode;
 * secrets always ask. Deletes go to a recoverable trash.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { sha1, UserError } from "../lib/util";
import { isBinaryPath, isSecretPath, WORK_DIR } from "../safety/paths";
import { trash } from "../workspace/trash";
import { Denied, defineTool, type ToolContext } from "./types";

/** Lockfiles, minified bundles and source maps: large, generated, and almost never worth reading whole. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.(js|css)$|\.map$/;

/** Most lines one read returns, and most characters one line keeps. A longer result is spilled to a file by the agent loop. */
const READ_LIMIT = 2_000;
const LINE_LIMIT = 2_000;
/** Files walked by one glob or grep call, and the largest file grep searches. */
const WALK_LIMIT = 5_000;
const GREP_FILE_LIMIT = 1_000_000;
const GLOB_RESULTS = 100;
const GREP_MATCHES = 250;

const splitLines = (content: string): string[] => {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

const clipLine = (line: string): string =>
  line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}... (line truncated to ${LINE_LIMIT} chars)` : line;

const readFooter = (from: number, to: number, total: number): string =>
  to < total ? `(Showing lines ${from}-${to} of ${total}. Use offset=${to + 1} to continue.)` : `(End of file - total ${total} lines)`;

const read = (ctx: ToolContext, rel: string): string | null => {
  const abs = ctx.fs.abs(rel);
  return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : null;
};

/** Refuses paths another running task owns, then: low risk for new files, working notes and files the team created; medium for your files; high for secrets. */
async function guardWrite(ctx: ToolContext, rel: string, kind: string, before: string | null, after: string | null, summary: string) {
  const owner = ctx.ownerOf(rel);
  if (owner) throw new Denied(`${rel} belongs to ${owner}, which is working on it now. Change only your own files; use ask_teammate if you need something there.`);
  if (isSecretPath(rel)) {
    await ctx.guard({ kind, risk: "high", summary: `${summary} (looks like a secrets file)`, preview: after ?? "", details: { path: rel, old: before ?? "", new: after ?? "" }, key: `${kind}:${rel}` });
    return;
  }
  const teamFile = rel.startsWith(`${WORK_DIR}/`) || ctx.db.artifacts.count("path = ? AND created = 1", [rel]) > 0;
  if (teamFile || (kind === "write_file" && before === null)) return;
  await ctx.guard({ kind, risk: "medium", summary, preview: after ?? "", details: { path: rel, old: before ?? "", new: after ?? "" }, key: `${kind}:${rel}` });
}

function writeText(ctx: ToolContext, rel: string, content: string) {
  const abs = ctx.fs.abs(rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  ctx.seen.set(rel, sha1(content));
}

export const fileTools = [
  defineTool({
    name: "glob",
    description: "Find project files by path pattern, such as src/**/*.ts. Returns up to 100 paths, newest first. Dependency and build folders are skipped.",
    args: z.object({ pattern: z.string().min(1).describe("Glob matched against project-relative paths") }),
    async run(ctx, a) {
      ctx.setStatus("reading", `Finding ${a.pattern}`);
      const { files, truncated } = ctx.fs.walk({ max: WALK_LIMIT, actor: "agent" });
      const modified = (f: string) => { try { return statSync(ctx.fs.abs(f)).mtimeMs; } catch { return 0; } };
      const matched = files.filter((f) => path.matchesGlob(f, a.pattern)).map((f) => ({ f, at: modified(f) })).sort((x, y) => y.at - x.at);
      if (!matched.length) return { text: `No files match ${a.pattern}${truncated ? ` in the first ${WALK_LIMIT} files` : ""}.`, metrics: { listed: true } };
      const shown = matched.slice(0, GLOB_RESULTS).map((m) => m.f);
      const notes = [
        matched.length > GLOB_RESULTS ? `(Showing ${GLOB_RESULTS} of ${matched.length} matching paths, newest first. Use a narrower pattern.)` : "",
        truncated ? `(The project has more than ${WALK_LIMIT} files; only the first ${WALK_LIMIT} were searched.)` : "",
      ].filter(Boolean);
      return { text: [...shown, ...notes].join("\n"), metrics: { listed: true } };
    },
  }),
  defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file and return line-numbered content. Use offset and limit to read a line range or continue a large file. Read several files in one step when you need them.",
    args: z.object({
      path: z.string(),
      offset: z.number().int().min(1).optional().describe("1-based first line to return. Defaults to 1."),
      limit: z.number().int().min(1).max(READ_LIMIT).optional().describe(`Lines to return, at most ${READ_LIMIT}. Defaults to ${READ_LIMIT}.`),
    }),
    async run(ctx, a) {
      const rel = ctx.fs.rel(a.path);
      ctx.setStatus("reading", `Reading ${rel}`);
      if (isBinaryPath(rel)) return { text: `${rel} is a binary file and cannot be read as text.`, ok: false };
      if (isSecretPath(rel)) await ctx.guard({ kind: "read_file", risk: "high", summary: `Read ${rel} (looks like a secrets file)`, details: { path: rel }, key: `read:${rel}` });
      const content = read(ctx, rel);
      if (content === null) return { text: `${rel} does not exist.`, ok: false };
      const hash = sha1(content);
      const lines = splitLines(content);
      if (GENERATED.test(rel) && a.offset === undefined && a.limit === undefined)
        return { text: `${rel} is a generated file (${lines.length} lines). Use grep to find what you need in it, or read a range with offset and limit.` };
      ctx.seen.set(rel, hash);
      const from = a.offset ?? 1;
      if (lines.length && from > lines.length) return { text: `offset ${from} is out of range for ${rel} (${lines.length} lines).`, ok: false };
      const to = Math.min(lines.length, from - 1 + (a.limit ?? READ_LIMIT));
      const prior = ctx.shown.get(rel);
      if (prior?.hash === hash && prior.ranges.some(([f, t]) => f <= from && t >= to))
        return { text: `${rel} lines ${from}-${to} have not changed since you read them; they are earlier in this conversation.`, metrics: { read: true, redundant: true } };
      ctx.shown.set(rel, { hash, ranges: [...(prior?.hash === hash ? prior.ranges : []), [from, to]] });
      const body = lines.slice(from - 1, to).map((line, i) => `${from + i}: ${clipLine(line)}`);
      return { text: [...body, readFooter(from, to, lines.length)].join("\n"), metrics: { read: true } };
    },
  }),
  defineTool({
    name: "grep",
    description: "Search file contents with a regular expression. Returns matching lines grouped by file, with line numbers, up to 250 matches. Use include to limit the files by path glob, such as src/**/*.ts.",
    args: z.object({
      pattern: z.string().min(1).describe("Regular expression, case-sensitive"),
      include: z.string().min(1).optional().describe("Glob the file paths must match"),
    }),
    async run(ctx, a) {
      ctx.setStatus("reading", `Searching for “${a.pattern}”`);
      let re: RegExp;
      try { re = new RegExp(a.pattern); }
      catch (e) { return { text: `Invalid regular expression: ${(e as Error).message}`, ok: false, metrics: { searched: true } }; }
      const out: string[] = [];
      let matches = 0;
      for (const f of ctx.fs.walk({ max: WALK_LIMIT, actor: "agent" }).files) {
        if (matches >= GREP_MATCHES) break;
        if ((a.include && !path.matchesGlob(f, a.include)) || isBinaryPath(f) || isSecretPath(f) || ctx.fs.size(f) > GREP_FILE_LIMIT) continue;
        const lines = splitLines(read(ctx, f) ?? "");
        const hits: string[] = [];
        for (let i = 0; i < lines.length && matches < GREP_MATCHES; i++) {
          if (!re.test(lines[i]!)) continue;
          matches++;
          hits.push(`  ${i + 1}: ${clipLine(lines[i]!.replace(/\r$/, ""))}`);
        }
        if (hits.length) out.push(f, ...hits);
      }
      if (!matches) return { text: "No matches.", metrics: { searched: true } };
      const note = matches >= GREP_MATCHES ? [`(Stopped at ${GREP_MATCHES} matches. Narrow the pattern or set include to see the rest.)`] : [];
      return { text: [...out, ...note].join("\n"), metrics: { searched: true } };
    },
  }),
  defineTool({
    name: "write_file",
    description: "Create a file or replace its whole content. Write complete, working content: no placeholders. To change part of an existing file prefer edit_file. Overwriting an existing file requires reading it first.",
    args: z.object({ path: z.string(), content: z.string(), note: z.string().optional().describe("Why this change, in a few words") }),
    async run(ctx, a) {
      const rel = ctx.fs.rel(a.path);
      if (!rel) throw new UserError("Give a file path");
      const before = read(ctx, rel);
      if (before !== null && ctx.seen.get(rel) !== sha1(before)) {
        return { text: `${rel} exists and ${ctx.seen.has(rel) ? "changed since you read it" : "you have not read it"}. Read it first, then write or use edit_file.`, ok: false };
      }
      if (before === a.content) return { text: `${rel} already has this content.` };
      ctx.setStatus("writing", `Writing ${rel}`);
      await guardWrite(ctx, rel, "write_file", before, a.content, `${before === null ? "Create" : "Overwrite"} ${rel}`);
      writeText(ctx, rel, a.content);
      ctx.shown.set(rel, { hash: sha1(a.content), ranges: [[1, a.content.split("\n").length]] });
      ctx.recordFile(rel, before, a.content, a.note ?? "");
      return { text: `${before === null ? "Created" : "Updated"} ${rel} (${a.content.split("\n").length} lines).`, metrics: { wrote: true } };
    },
  }),
  defineTool({
    name: "edit_file",
    description: "Replace one exact snippet in a file. old_string must appear exactly once (include surrounding lines to make it unique); set replace_all to change every occurrence.",
    args: z.object({ path: z.string(), old_string: z.string().min(1), new_string: z.string(), replace_all: z.boolean().optional(), note: z.string().optional() }),
    async run(ctx, a) {
      const rel = ctx.fs.rel(a.path);
      const before = read(ctx, rel);
      if (before === null) return { text: `${rel} does not exist. Use write_file to create it.`, ok: false };
      const count = before.split(a.old_string).length - 1;
      if (count === 0) return { text: `old_string was not found in ${rel}. Read the file again and copy the exact text, including whitespace.`, ok: false };
      if (count > 1 && !a.replace_all) return { text: `old_string appears ${count} times in ${rel}. Include more surrounding lines, or set replace_all.`, ok: false };
      const after = a.replace_all ? before.split(a.old_string).join(a.new_string) : before.replace(a.old_string, () => a.new_string);
      ctx.setStatus("writing", `Editing ${rel}`);
      await guardWrite(ctx, rel, "write_file", before, after, `Edit ${rel}`);
      writeText(ctx, rel, after);
      // The edited lines are in this conversation now: a later read of them costs one line. The rest of the file is not,
      // so it is left out of the ledger and a read of it still returns the content.
      if (a.replace_all) ctx.shown.delete(rel);
      else {
        const at = before.indexOf(a.old_string);
        const from = before.slice(0, at).split("\n").length;
        const to = from + a.new_string.split("\n").length - 1;
        ctx.shown.set(rel, { hash: sha1(after), ranges: [[from, Math.max(from, to)]] });
      }
      ctx.recordFile(rel, before, after, a.note ?? "");
      return { text: `Edited ${rel} (${count > 1 ? `${count} replacements` : "1 replacement"}).`, metrics: { wrote: true } };
    },
  }),
  defineTool({
    name: "move_file",
    description: "Move or rename a file or folder inside the project.",
    args: z.object({ from: z.string(), to: z.string() }),
    async run(ctx, a) {
      const from = ctx.fs.rel(a.from);
      const to = ctx.fs.rel(a.to);
      if (!existsSync(ctx.fs.abs(from))) return { text: `${from} does not exist.`, ok: false };
      if (existsSync(ctx.fs.abs(to))) return { text: `${to} already exists; choose another name.`, ok: false };
      const owner = ctx.ownerOf(to);
      if (owner) throw new Denied(`${to} belongs to ${owner}, which is working on it now.`);
      await guardWrite(ctx, from, "move_file", read(ctx, from), null, `Move ${from} → ${to}`);
      mkdirSync(path.dirname(ctx.fs.abs(to)), { recursive: true });
      renameSync(ctx.fs.abs(from), ctx.fs.abs(to));
      const content = read(ctx, to);
      if (content !== null) { ctx.recordFile(from, content, null, `Moved to ${to}`); ctx.recordFile(to, null, content, `Moved from ${from}`); }
      ctx.emit("file_moved", { from, to });
      return { text: `Moved ${from} to ${to}.`, metrics: { wrote: true } };
    },
  }),
  defineTool({
    name: "delete_file",
    description: "Delete a file or folder. It goes to the project trash and can be restored.",
    args: z.object({ path: z.string(), reason: z.string().optional() }),
    async run(ctx, a) {
      const rel = ctx.fs.rel(a.path);
      if (!existsSync(ctx.fs.abs(rel))) return { text: `${rel} does not exist.`, ok: false };
      const before = read(ctx, rel);
      await guardWrite(ctx, rel, "delete_file", before, null, `Delete ${rel}${a.reason ? `: ${a.reason}` : ""}`);
      trash(ctx.fs, rel, "agent");
      if (before !== null) ctx.recordFile(rel, before, null, a.reason ?? "Deleted");
      ctx.emit("file_moved", { from: rel, to: "" });
      return { text: `Moved ${rel} to the trash.`, metrics: { wrote: true } };
    },
  }),
];
