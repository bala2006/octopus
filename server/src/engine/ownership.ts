/**
 * Which task may write which paths. A task owns files and folders; two tasks that write run at the same time only when
 * what they own does not overlap, and a running task's paths are off limits to everyone else.
 */
import type { TaskOut } from "@octopus/shared";

/**
 * Ownership is decided by literal path prefixes. A glob keeps only the folder before its first wildcard (`src/**\/*.ts`
 * owns all of `src`), so it never owns less than it says. On Windows paths compare without case.
 */
const norm = (p: string) => {
  let o = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const glob = o.search(/[*?[{]/);
  if (glob >= 0) o = o.slice(0, glob).replace(/[^/]*$/, "");
  o = o.replace(/\/+$/, "").replace(/^\.$/, "");
  return process.platform === "win32" ? o.toLowerCase() : o;
};

/** `src/game` owns `src/game/world.js` but not `src/gameplay.js`. */
export function owns(paths: string[], rel: string): boolean {
  const r = norm(rel);
  return paths.some((p) => { const o = norm(p); return o === "" || r === o || r.startsWith(`${o}/`); });
}

const overlap = (a: string[], b: string[]) => a.some((p) => owns(b, p)) || b.some((p) => owns(a, p));

/** Tasks that change files. Reviews and acceptance checks only read and run. */
export const writes = (t: Pick<TaskOut, "kind">) => t.kind !== "review" && t.kind !== "verify";

/** Whether `next` can start while `running` runs: a task that owns nothing may write anywhere, so it runs alone. */
export function canRunBeside(next: Pick<TaskOut, "kind" | "files">, running: Pick<TaskOut, "kind" | "files">[]): boolean {
  if (!writes(next)) return true;
  return running.filter(writes).every((r) => next.files.length > 0 && r.files.length > 0 && !overlap(next.files, r.files));
}
