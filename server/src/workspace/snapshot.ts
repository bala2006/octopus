/**
 * A record of the project's files taken before read-only specialists run commands, and the way back from it. A check
 * command can still rewrite a file (a snapshot update, a formatter given a write flag), so the record is what undoes it.
 *
 * A project has one open record at a time. Rounds of the same owner share it, and a round of another owner waits until
 * the first owner's rounds end. The wait covers specialist rounds only. A main agent in another conversation can still
 * write to the project during a round, and the restore can revert that write.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SNAPSHOT_MAX_FILES = 4_000;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
/** The most file content one record holds in memory. A project over it gets no record, so its rounds are not undone. */
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

/** Put back every recorded file that changed or went missing, and delete every file the record does not hold. */
export function restoreSnapshot(root: string, snap: Snapshot): Restored {
  const restored: string[] = [];
  for (const [rel, saved] of snap.files) {
    const abs = path.join(root, rel);
    if (existsSync(abs) && hashOf(readFileSync(abs)) === saved.hash) continue;
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, saved.bytes);
    restored.push(rel);
  }
  const deleted: string[] = [];
  if (!snap.partial) {
    for (const rel of walk(root).paths) {
      if (snap.files.has(rel)) continue;
      unlinkSync(path.join(root, rel));
      deleted.push(rel);
    }
  }
  return { restored, deleted, partial: snap.partial };
}

interface Open { owner: object; rounds: number; snap: Snapshot | null; waiting: (() => void)[] }
const open = new Map<string, Open>();

/**
 * Starts a round in a project. The first round takes the record. Later rounds of the same owner share it. A round of
 * another owner waits until the rounds in progress end. `undoable` is false when the project is over the total cap, and
 * then the round's changes are not restored.
 */
export async function enterRound(root: string, owner: object): Promise<{ undoable: boolean }> {
  for (;;) {
    const entry = open.get(root);
    if (!entry) {
      const snap = takeSnapshot(root);
      open.set(root, { owner, rounds: 1, snap, waiting: [] });
      return { undoable: snap !== null };
    }
    if (entry.owner === owner) {
      entry.rounds++;
      return { undoable: entry.snap !== null };
    }
    await new Promise<void>((wake) => entry.waiting.push(wake));
  }
}

/**
 * Ends a round. When the owner's last round in the project ends, the project is put back from its record, the waiting
 * rounds of other owners are let in, and the report is returned. Otherwise the result is null.
 */
export function leaveRound(root: string, owner: object): Restored | null {
  const entry = open.get(root);
  if (!entry || entry.owner !== owner) return null;
  entry.rounds--;
  if (entry.rounds > 0) return null;
  open.delete(root);
  try {
    return entry.snap ? restoreSnapshot(root, entry.snap) : null;
  } finally {
    for (const wake of entry.waiting) wake();
  }
}
