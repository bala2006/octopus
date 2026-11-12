/**
 * File history. Every change an agent makes is stored as a version (with author and reason), so the Changes view can
 * show diffs and revert any file to any version. The first change to a file that already existed also stores the
 * original, so "revert" can always go back to what you had.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ArtifactOut } from "@octopus/shared";
import type { ArtifactRow, ProjectDb } from "../db/project";
import { newId, now, UserError } from "../lib/util";
import type { ProjectFs } from "../safety/paths";
import { trash } from "./trash";

const lines = (s: string | null) => (s ? s.split("\n").length : 0);
export const artifactOut = ({ content: _c, created: _cr, ...a }: ArtifactRow): ArtifactOut => a;

function latestVersion(db: ProjectDb, rel: string): number {
  return Number(db.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM artifacts WHERE path = ?", rel)?.v ?? 0);
}

/** Store a new version of `rel`. Returns the row and line counts for the event. */
export function recordVersion(db: ProjectDb, o: { runId: string; path: string; before: string | null; after: string | null; author: string | null; note: string }) {
  let version = latestVersion(db, o.path);
  if (version === 0 && o.before !== null) {
    db.artifacts.insert({ id: newId(), run_id: o.runId, path: o.path, version: ++version, content: o.before, author_agent_id: null,
      change_note: "Original, before the team changed it", created: false, deleted: false, size: Buffer.byteLength(o.before), created_at: now() });
  }
  const row: ArtifactRow = {
    id: newId(), run_id: o.runId, path: o.path, version: version + 1, content: o.after, author_agent_id: o.author, change_note: o.note,
    created: o.before === null, deleted: o.after === null, size: o.after ? Buffer.byteLength(o.after) : 0, created_at: now(),
  };
  db.artifacts.insert(row);
  return { row, lines: lines(o.after), previous_lines: lines(o.before) };
}

export function listArtifacts(db: ProjectDb, runId: string, allVersions: boolean): ArtifactOut[] {
  const rows = db.artifacts.find("run_id = ?", [runId], "path, version");
  if (allVersions) return rows.map(artifactOut);
  const latest = new Map<string, ArtifactRow>();
  for (const r of rows) latest.set(r.path, r);
  return [...latest.values()].map(artifactOut);
}

export function artifactVersion(db: ProjectDb, rel: string, version?: number | null): ArtifactRow {
  const row = version ? db.artifacts.one("path = ? AND version = ?", [rel, version]) : db.artifacts.find("path = ?", [rel], "version DESC")[0];
  if (!row) throw new UserError(`No saved version of ${rel}`, 404);
  return row;
}

/** Put a file back to a stored version (0 = the version before the conversation first changed it). */
export function revertFile(db: ProjectDb, fs: ProjectFs, runId: string, rel: string, toVersion = 0): number {
  const versions = db.artifacts.find("path = ?", [rel], "version");
  if (!versions.length) throw new UserError(`No saved version of ${rel}`, 404);
  let target: ArtifactRow | undefined;
  let content: string | null;
  if (toVersion) {
    target = versions.find((v) => v.version === toVersion);
    if (!target) throw new UserError(`Version ${toVersion} of ${rel} does not exist`, 404);
    content = target.deleted ? null : target.content;
  } else {
    const i = Math.max(0, versions.findIndex((v) => v.run_id === runId));
    const first = versions[i]!;
    target = first.created ? first : !first.author_agent_id ? first : versions[i - 1] ?? first;
    content = first.created ? null : target.content;
  }
  const abs = fs.abs(rel, "user");
  const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  if (content === null) {
    if (current !== null) trash(fs, rel, "user");
  } else {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const note = content === null ? "Reverted: removed (the team created it)" : `Reverted to version ${target.version}`;
  return recordVersion(db, { runId, path: rel, before: current, after: content, author: null, note }).row.version;
}
