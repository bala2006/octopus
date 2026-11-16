/**
 * A record of the project's files, taken around one shell command that a specialist runs, and the way back from it. A check
 * command can still rewrite a file (a snapshot update, a formatter given a write flag), so the record is what undoes it.
 *
 * Each command takes its own record, so an undo removes only what that command changed. The calls that can write, the
 * shell and the browser, take one lock per project and run one at a time. Reads do not take it. A file a browser call was
 * asked to write is kept in every undo, because a screenshot is output, not a side effect of a check.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SNAPSHOT_MAX_FILES = 4_000;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** The most file content one record holds in memory. A project over it gets no record, so its commands are not undone. */
export const SNAPSHOT_MAX_TOTAL = 64 * 1024 * 1024;
/** Folders the record never walks: version control, Octopus's own state, and what builds and installs produce. */
const SKIPPED = new Set([".git", ".octopus", "node_modules", "dist", "build", "coverage", ".next", ".turbo", ".venv", "venv", "__pycache__", "target"]);

interface SavedFile { hash: string; bytes: Buffer }
export interface Snapshot {
  files: Map<string, SavedFile>;
  /** True when the folder had more files than the record holds. Files that are not in the record are then never deleted. */
  partial: boolean;
}
export interface Restored { restored: string[]; deleted: string[]; partial: boolean }

const hashOf = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

/** The project files the record covers, relative to the root with forward slashes, up to the file cap. */
function walk(root: string): { paths: string[]; capped: boolean } {
  const paths: string[] = [];
  const folders = [""];
  while (folders.length) {
    const dir = folders.pop()!;
    let entries;
    try { entries = readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) folders.push(rel);
        continue;
      }
      if (!entry.isFile() || statSync(path.join(root, rel)).size >= SNAPSHOT_MAX_BYTES) continue;
      if (paths.length === SNAPSHOT_MAX_FILES) return { paths, capped: true };
      paths.push(rel);
    }
  }
  return { paths, capped: false };
}

/** The record of the project's files, or null when they add up to more than the total cap. */
export function takeSnapshot(root: string): Snapshot | null {
  const { paths, capped } = walk(root);
  const files = new Map<string, SavedFile>();
  let total = 0;
  for (const rel of paths) {
    const bytes = readFileSync(path.join(root, rel));
    total += bytes.length;
    if (total > SNAPSHOT_MAX_TOTAL) return null;
    files.set(rel, { hash: hashOf(bytes), bytes });
  }
  return { files, partial: capped };
}

/** Files a browser call was asked to write, per project root, relative to the root. Every undo leaves them as they are. */
const browserOutput = new Map<string, Set<string>>();

/** Records the file a browser call names. A relative name is tried from the project root and from the browser's output folder. */
export function keepBrowserOutput(root: string, filename: string) {
  const kept = browserOutput.get(root) ?? new Set<string>();
  browserOutput.set(root, kept);
  for (const base of [root, path.join(root, ".octopus", "browser")]) {
    const rel = path.relative(root, path.resolve(base, filename));
    if (rel && rel.split(path.sep)[0] !== ".." && !path.isAbsolute(rel)) kept.add(rel.split(path.sep).join("/"));
  }
}

/** Put back every recorded file that changed or went missing, and delete every file the record does not hold, except browser output. */
export function restoreSnapshot(root: string, snap: Snapshot): Restored {
  const kept = browserOutput.get(root) ?? new Set<string>();
  const restored: string[] = [];
  for (const [rel, saved] of snap.files) {
    const abs = path.join(root, rel);
    if (kept.has(rel) || (existsSync(abs) && hashOf(readFileSync(abs)) === saved.hash)) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, saved.bytes);
    restored.push(rel);
  }
  const deleted: string[] = [];
  if (!snap.partial) {
    for (const rel of walk(root).paths) {
      if (snap.files.has(rel) || kept.has(rel)) continue;
      unlinkSync(path.join(root, rel));
      deleted.push(rel);
    }
  }
  return { restored, deleted, partial: snap.partial };
}

/** The last call queued on each project. A new call starts after it. */
const queue = new Map<string, Promise<void>>();

/** Runs `run` once every write-capable call that was queued before it in this project has ended. */
export function inProjectLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const before = queue.get(root) ?? Promise.resolve();
  let finish!: () => void;
  const turn = new Promise<void>((done) => { finish = done; });
  const tail = before.then(() => turn);
  queue.set(root, tail);
  return before.then(async () => {
    try {
      return await run();
    } finally {
      finish();
      if (queue.get(root) === tail) queue.delete(root);
    }
  });
}

export interface UndoneCommand<T> { value: T; undoable: boolean; undone: Restored | null }

/**
 * Runs one shell command under the project lock, with a record taken just before it, and puts back what it changed. The
 * record is null when the project is over the total cap, and then nothing is put back.
 */
export function undoableCommand<T>(root: string, run: () => Promise<T>): Promise<UndoneCommand<T>> {
  return inProjectLock(root, async () => {
    const snap = takeSnapshot(root);
    try {
      const value = await run();
      return { value, undoable: snap !== null, undone: snap ? restoreSnapshot(root, snap) : null };
    } catch (e) {
      if (snap) restoreSnapshot(root, snap);
      throw e;
    }
  });
}
