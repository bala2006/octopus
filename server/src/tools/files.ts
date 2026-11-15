/**
 * File tools. Reads are free. Writes are versioned (every change can be reverted from Changes) and guarded: creating
 * files, and editing files the team created, run straight away; editing your existing files asks first in "ask" mode;
 * secrets always ask. Deletes go to a recoverable trash.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { clip, sha1, UserError } from "../lib/util";
import { isBinaryPath, isSecretPath, WORK_DIR } from "../safety/paths";
import { trash } from "../workspace/trash";
import { Denied, defineTool, MAX_TOOL_OUTPUT, type ToolContext } from "./types";

/** Lockfiles, minified bundles and source maps: large, generated, and almost never worth reading whole. */
const GENERATED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.(js|css)$|\.map$/;

/** The lines from `from` that fit in one tool result, stopping at `to`. Always at least one line. */
function page(lines: string[], from: number, to: number): number {
  let size = 0;
  let end = from - 1;
  while (end < to && size + lines[end]!.length + 1 <= MAX_TOOL_OUTPUT) size += lines[end++]!.length + 1;
  return Math.max(end, from);
}

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
    name: "list_files",
    description: "List files in the project (dependency and build folders are skipped). Use a folder path to narrow it down.",
    args: z.object({ path: z.string().optional().describe("Folder relative to the project root; empty for the whole project") }),
    async run(ctx, a) {
      ctx.setStatus("reading", `Listing ${a.path || "files"}`);
      const { files, truncated } = ctx.fs.walk({ base: a.path, max: 600, actor: "agent" });
      if (!files.length) return { text: a.path ? `${a.path} is empty or does not exist.` : "The project folder is empty." };
      return { text: files.map((f) => `${f}  (${ctx.fs.size(f)} B)`).join("\n") + (truncated ? "\n… more files not shown; list a subfolder." : "") };
    },
  }),
  defineTool({
    name: "read_file",
    description: "Read a text file. Large files come back one page at a time: the header says which lines you got and where to continue. Pass start_line/end_line (1-based, inclusive) to read part of a file. Read several files in one step when you need them.",
    args: z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
    async run(ctx, a) {
      const rel = ctx.fs.rel(a.path);
      ctx.setStatus("reading", `Reading ${rel}`);
      if (isBinaryPath(rel)) return { text: `${rel} is a binary file and cannot be read as text.`, ok: false };
      if (isSecretPath(rel)) await ctx.guard({ kind: "read_file", risk: "high", summary: `Read ${rel} (looks like a secrets file)`, details: { path: rel }, key: `read:${rel}` });
      const content = read(ctx, rel);
      if (content === null) return { text: `${rel} does not exist.`, ok: false };
      const hash = sha1(content);
      const lines = content.split("\n");
      if (GENERATED.test(rel) && a.start_line === undefined && a.end_line === undefined)
        return { text: `${rel} is a generated file (${lines.length} lines). Use search_project to find what you need in it, or read a line range.` };
      ctx.seen.set(rel, hash);
      const from = Math.min(a.start_line ?? 1, lines.length);
      const to = page(lines, from, Math.min(a.end_line ?? lines.length, lines.length));
      const prior = ctx.shown.get(rel);
      if (prior?.hash === hash && prior.ranges.some(([f, t]) => f <= from && t >= to))
        return { text: `${rel} lines ${from}-${to} have not changed since you read them; they are earlier in this conversation.` };
      ctx.shown.set(rel, { hash, ranges: [...(prior?.hash === hash ? prior.ranges : []), [from, to]] });
      const range = to < lines.length ? `, showing ${from}-${to}; continue with start_line ${to + 1}` : from > 1 ? `, showing ${from}-${to}` : "";
      return { text: `${rel} (${lines.length} lines${range})\n${clip(lines.slice(from - 1, to).join("\n"), MAX_TOOL_OUTPUT)}` };
    },
  }),
  defineTool({
    name: "search_project",
    description: "Search file contents for text (case-insensitive) or a regular expression. Returns matching lines with paths.",
    args: z.object({ query: z.string().min(1), regex: z.boolean().optional(), path: z.string().optional() }),
    async run(ctx, a) {
      ctx.setStatus("reading", `Searching for “${a.query}”`);
      let re: RegExp;
      try { re = a.regex ? new RegExp(a.query, "i") : new RegExp(a.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      catch (e) { return { text: `Invalid regular expression: ${(e as Error).message}`, ok: false }; }
      const hits: string[] = [];
      for (const f of ctx.fs.walk({ base: a.path, max: 4000, actor: "agent" }).files) {
        if (isBinaryPath(f) || isSecretPath(f) || ctx.fs.size(f) > 1_000_000) continue;
        const lines = (read(ctx, f) ?? "").split("\n");
        lines.forEach((l, i) => { if (hits.length < 120 && re.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 200)}`); });
        if (hits.length >= 120) break;
      }
      return { text: hits.length ? hits.join("\n") : "No matches." };
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
      return { text: `${before === null ? "Created" : "Updated"} ${rel} (${a.content.split("\n").length} lines).` };
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
      ctx.recordFile(rel, before, after, a.note ?? "");
      return { text: `Edited ${rel} (${count > 1 ? `${count} replacements` : "1 replacement"}).` };
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
      return { text: `Moved ${from} to ${to}.` };
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
      return { text: `Moved ${rel} to the trash.` };
    },
  }),
];
