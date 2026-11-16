/**
 * A record of the project's files taken before read-only specialists run commands, and the way back from it. A check
 * command can still rewrite a file (a snapshot update, a formatter given a write flag), so the record is what undoes it.
 * Rounds that overlap in one project share one record. The main agent waits while they run, so nothing else writes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SNAPSHOT_MAX_FILES = 4_000;
export const SNAPSHOT_MAX_BYTES = 1024 * 1024;
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

export function takeSnapshot(root: string): Snapshot {
  const { paths, capped } = walk(root);
  const files = new Map<string, SavedFile>();
  for (const rel of paths) {
    const bytes = readFileSync(path.join(root, rel));
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

interface Open { snap: Snapshot; rounds: number }
const open = new Map<string, Open>();

/** A round is starting in this project. The first one in takes the record; the others share it. */
export function enterRound(root: string): void {
  const entry = open.get(root);
  if (entry) entry.rounds++;
  else open.set(root, { snap: takeSnapshot(root), rounds: 1 });
}

/** A round has ended. When the last one ends, the project is restored and the report returned; otherwise null. */
export function leaveRound(root: string): Restored | null {
  const entry = open.get(root);
  if (!entry) return null;
  entry.rounds--;
  if (entry.rounds > 0) return null;
  open.delete(root);
  return restoreSnapshot(root, entry.snap);
}
