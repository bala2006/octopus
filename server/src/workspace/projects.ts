/**
 * Project folders. A project is any folder you open; Octopus keeps its data in `<folder>/.octopus/` (like `.git`):
 * the database, the agents' working notes, trash and browser output. Opening the folder again brings everything back.
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { BrowseOut, WorkspaceOut } from "@octopus/shared";
import { config } from "../config";
import { openProject, type ProjectDb } from "../db/project";
import type { Registry, WorkspaceRow } from "../db/registry";
import { newId, notFound, now, UserError } from "../lib/util";
import { ProjectFs, WORK_DIR } from "../safety/paths";

export interface Project { id: string; name: string; root: string; db: ProjectDb; fs: ProjectFs }
const open = new Map<string, Project>();

const README = `# .octopus

Octopus keeps this project's company, conversations and file history here. It is safe to delete (you lose that history)
and is ignored by Git. Agents may only write inside \`work/\`.
`;

function inAllowedRoot(p: string) {
  return config.allowedRoots.some((r) => p === r || p.startsWith(r + path.sep));
}

export function validateDir(input: string): string {
  if (!input.trim()) throw new UserError("Choose a folder");
  const abs = path.resolve(input.replace(/^~(?=$|[\\/])/, homedir()));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new UserError(`${abs} is not a folder`);
  const real = realpathSync(abs);
  if (real === path.parse(real).root || real === homedir()) throw new UserError("Choose a project folder, not your whole drive or home folder");
  return real;
}

export function initProject(root: string): boolean {
  const existed = existsSync(path.join(root, ".octopus", "octopus.db"));
  mkdirSync(path.join(root, WORK_DIR), { recursive: true });
  const write = (rel: string, text: string) => { const f = path.join(root, ".octopus", rel); if (!existsSync(f)) writeFileSync(f, text); };
  write(".gitignore", "*\n");
  write("README.md", README);
  return existed;
}

export function workspaceOut(w: WorkspaceRow): WorkspaceOut {
  return { ...w, exists: existsSync(w.path), existing_project: existsSync(path.join(w.path, ".octopus", "octopus.db")) };
}

/** Register a folder (or return the existing registration), creating `.octopus/`. */
export function addWorkspace(reg: Registry, dir: string, name?: string | null): WorkspaceOut {
  const root = validateDir(dir);
  const existed = initProject(root);
  const found = reg.workspaces.one("path = ?", [root]);
  const row = found ? reg.workspaces.update(found.id, { last_opened_at: now(), ...(name ? { name } : {}) })!
    : reg.workspaces.insert({ id: newId(), name: name?.trim() || path.basename(root), path: root, created_at: now(), last_opened_at: now() });
  return { ...workspaceOut(row), existing_project: existed };
}

/** The open project for a workspace id: database, file boundary and root. */
export function project(reg: Registry, id: string): Project {
  const hit = open.get(id);
  if (hit && existsSync(hit.root)) return hit;
  const w = reg.workspaces.get(id);
  if (!w) throw notFound("Project");
  if (!existsSync(w.path)) throw new UserError(`The folder ${w.path} no longer exists`, 404);
  initProject(w.path);
  const p: Project = { id, name: w.name, root: w.path, db: openProject(w.path), fs: new ProjectFs(w.path) };
  open.set(id, p);
  return p;
}

export function closeProject(id: string) {
  open.get(id)?.db.db.close();
  open.delete(id);
}

export const openProjects = () => [...open.values()];

/** The in-app folder browser (used when the system folder dialog is unavailable). */
export function browse(input: string | null | undefined, showHidden = false): BrowseOut {
  const roots = config.allowedRoots.filter((r) => existsSync(r));
  if (!input) return { path: null, parent: null, roots, entries: roots.map((r) => ({ name: r, path: r, is_git: existsSync(path.join(r, ".git")), is_project: existsSync(path.join(r, ".octopus")) })) };
  const dir = path.resolve(input);
  if (!inAllowedRoot(dir)) throw new UserError("That folder is outside the folders Octopus may browse (WORKSPACE_ALLOWED_ROOTS)", 403);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UserError(`${dir} is not a folder`, 404);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (showHidden || !e.name.startsWith(".")) && e.name !== "node_modules")
    .map((e) => { const p = path.join(dir, e.name); return { name: e.name, path: p, is_git: existsSync(path.join(p, ".git")), is_project: existsSync(path.join(p, ".octopus")) }; })
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir && inAllowedRoot(parent) ? parent : null, roots, entries };
}
