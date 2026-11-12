/** Where the agents keep their working documents (plans, specs, briefs, QA notes): outside the user's project tree. */
export const WORK_PREFIX = ".octopus/work/";

/** Split a file list into the project's own files and the agents' working documents (only for the project view). */
export function splitWork<T extends { path: string; area?: string }>(files: T[], split: boolean): [T[], T[]] {
  if (!split) return [files, []];
  const isWork = (f: T) => f.area === "work" || f.path.startsWith(WORK_PREFIX);
  return [files.filter((f) => !isWork(f)), files.filter(isWork)];
}
