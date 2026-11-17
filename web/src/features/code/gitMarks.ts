import type { GitFile } from "@octopus/shared";

/** How Git reports one changed path. */
export type Tone = "untracked" | "added" | "modified" | "deleted";

const SEVERITY: Record<Tone, number> = {
  untracked: 1,
  added: 2,
  modified: 3,
  deleted: 4,
};

export const NO_CHANGES: ReadonlyMap<string, Tone> = new Map();

/**
 * Reads a porcelain v1 status code such as " M", "M ", "A ", or "??".
 * The worktree column wins because it describes the file on disk.
 */
export function toneOf(code: string): Tone {
  if (code === "??") return "untracked";
  const worktree = code[1] !== " " ? code[1] : code[0];
  if (worktree === "D") return "deleted";
  if (worktree === "A") return "added";
  return "modified";
}

export function changesByPath(
  files: readonly GitFile[],
): ReadonlyMap<string, Tone> {
  return new Map(files.map((file) => [file.path, toneOf(file.status)]));
}

/** A folder shows the most severe tone among the changed files below it. */
export function folderTones(
  changes: ReadonlyMap<string, Tone>,
): ReadonlyMap<string, Tone> {
  const folders = new Map<string, Tone>();
  for (const [path, tone] of changes) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join("/");
      const current = folders.get(folder);
      if (!current || SEVERITY[tone] > SEVERITY[current]) {
        folders.set(folder, tone);
      }
    }
  }
  return folders;
}
