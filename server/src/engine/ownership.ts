/**
 * Which task may write which paths. A task owns files and folders; two tasks that write run at the same time only when
 * what they own does not overlap, and a running task's paths are off limits to everyone else.
 */
import type { TaskOut } from "@octopus/shared";

const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/\*\*?$/, "").replace(/\/+$/, "").replace(/^\.$/, "");

/** `src/game` owns `src/game/world.js` but not `src/gameplay.js`. */
export function owns(paths: string[], rel: string): boolean {
  const r = norm(rel);
  return paths.some((p) => { const o = norm(p); return o === "" || r === o || r.startsWith(`${o}/`); });
}

const overlap = (a: string[], b: string[]) => a.some((p) => owns(b, p)) || b.some((p) => owns(a, p));

/** Tasks that change files. Reviews only read. */
export const writes = (t: Pick<TaskOut, "kind">) => t.kind !== "review";

/** Whether `next` can start while `running` runs: a task that owns nothing may write anywhere, so it runs alone. */
export function canRunBeside(next: Pick<TaskOut, "kind" | "files">, running: Pick<TaskOut, "kind" | "files">[]): boolean {
  if (!writes(next)) return true;
  return running.filter(writes).every((r) => next.files.length > 0 && r.files.length > 0 && !overlap(next.files, r.files));
}
