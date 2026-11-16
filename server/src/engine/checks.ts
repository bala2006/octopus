/**
 * The project's own checks, run after the agents change code: which checks run for a set of changed files, which are
 * skipped and why, and running them. The team path and the solo path both use it.
 */
import { existsSync, readFileSync } from "node:fs";
import type { ProjectTask } from "@octopus/shared";
import { run as runProcess, safeEnv } from "../lib/proc";
import { clip, sha1 } from "../lib/util";
import { parseCommand } from "../safety/commands";
import { isBinaryPath, isSecretPath, type ProjectFs } from "../safety/paths";
import { verificationChecks } from "../workspace/overview";
import { checksCanBeSkipped, DOC_OR_ASSET, type SourceFile } from "./checkScope";

/** One check's outcome. The output is kept to 6,000 characters. */
export interface CheckRun { name: string; command: string; ok: boolean; output: string }

/** What a change needs from the checks: nothing to run, a reason to skip, or the checks to run under a cache key. */
export type CheckPlan =
  | { kind: "none" }
  | { kind: "skipped"; reason: string }
  | { kind: "passed" }
  | { kind: "run"; checks: ProjectTask[]; key: string };

/** What a run reports as it goes. */
export interface CheckHooks {
  /** True when the run must stop before the next check. */
  stopped(): boolean;
  started(check: ProjectTask): void;
  finished(check: ProjectTask, ok: boolean, output: string): void;
}

const OUTPUT_LIMIT = 6000;

/** The project's text files that are not documents or assets: what a check or a build could read. */
export function sourceFiles(fs: ProjectFs): SourceFile[] {
  const files: SourceFile[] = [];
  for (const f of fs.walk({ max: 20_000 }).files) {
    if (DOC_OR_ASSET.test(f) || isBinaryPath(f) || isSecretPath(f) || fs.size(f) > 1_000_000) continue;
    try { files.push({ path: f, text: readFileSync(fs.abs(f), "utf8") }); } catch { continue; }
  }
  return files;
}

/** A hash of a file's content, or null when the file is gone. */
export function hashFile(fs: ProjectFs, rel: string): string | null {
  try {
    const abs = fs.abs(rel);
    return existsSync(abs) ? sha1(readFileSync(abs, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * Decides what the checks do for these changed files. Documents and images skip the checks unless the project reads them.
 * Files whose content already passed these checks (`passed` holds the keys of earlier passes) are not run again.
 */
export function planChecks(fs: ProjectFs, changed: string[], passed: Set<string>): CheckPlan {
  const checks = verificationChecks(fs);
  if (!checks.length) return { kind: "none" };
  if (changed.every((f) => DOC_OR_ASSET.test(f)) && checksCanBeSkipped(changed, sourceFiles(fs))) {
    return { kind: "skipped", reason: "Only documents and assets changed, and nothing in the project reads them" };
  }
  const key = `${checks.map((c) => c.command).join("|")}::${changed.map((f) => `${f}:${hashFile(fs, f) ?? "gone"}`).join(",")}`;
  if (changed.length && passed.has(key)) return { kind: "passed" };
  return { kind: "run", checks, key };
}

/** Runs the checks one after another. Returns null when `hooks.stopped` is true before one of them starts. */
export async function runCheckList(fs: ProjectFs, checks: ProjectTask[], signal: AbortSignal, hooks: CheckHooks): Promise<CheckRun[] | null> {
  const results: CheckRun[] = [];
  for (const c of checks) {
    if (hooks.stopped()) return null;
    hooks.started(c);
    const res = await runProcess(parseCommand(c.command), { cwd: fs.abs(c.directory === "." ? "" : c.directory), env: safeEnv(), timeoutMs: 300_000, maxOutput: 30_000, signal });
    const ok = res.code === 0 && !res.timedOut;
    results.push({ name: c.name, command: c.command, ok, output: clip(res.output, OUTPUT_LIMIT) });
    hooks.finished(c, ok, res.output);
  }
  return results;
}
