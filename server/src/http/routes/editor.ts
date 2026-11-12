/** The code workspace: documents with conflict-aware saves, file items and trash, search, Git, terminal and dev server. */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  CommandInputSchema, FileVersionSchema, FolderInSchema, GitCommitSchema, GitStageSchema, LocalBranchSchema, LocalEnvironmentSchema,
  LocalWorktreeSchema, MoveDocumentSchema, SaveDocumentSchema, StartCommandSchema, StartServerSchema, type FileItem,
} from "@octopus/shared";
import type { Registry } from "../../db/registry";
import { notFound, sha1, UserError } from "../../lib/util";
import { isBinaryPath, isSecretPath, type ProjectFs } from "../../safety/paths";
import { saveEnvironment } from "../../workspace/environment";
import * as git from "../../workspace/git";
import { projectTasks } from "../../workspace/overview";
import { processes } from "../../workspace/processes";
import { addWorkspace, project } from "../../workspace/projects";
import { listTrash, restore, trash } from "../../workspace/trash";
import type { RouteFn } from "../router";
import { sendFile } from "./files";

const MAX_DOC = 5_000_000;

function item(fs: ProjectFs, rel: string): FileItem {
  const abs = fs.abs(rel, "user");
  if (!existsSync(abs)) throw notFound(rel);
  const st = statSync(abs);
  const kind = st.isDirectory() ? "folder" : "file";
  return { path: fs.rel(rel, "user"), kind, size: kind === "file" ? st.size : 0, revision: kind === "file" ? sha1(readFileSync(abs)) : sha1(`${st.mtimeMs}`) };
}

function readDoc(fs: ProjectFs, rel: string) {
  const p = fs.rel(rel, "user");
  const abs = fs.abs(p, "user");
  if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound(p);
  if (isBinaryPath(p)) throw new UserError("This is a binary file", 415);
  const size = statSync(abs).size;
  if (size > MAX_DOC) throw new UserError("File too large to edit here", 413);
  const content = readFileSync(abs, "utf8");
  return { path: p, content, size, revision: sha1(content) };
}

export function editorRoutes(route: RouteFn, app: FastifyInstance, reg: Registry) {
  const E = "/api/v1/w/{workspace_id}/editor" as const;
  route("GET", `${E}/tree`, ({ project }) => project().fs.walk({ max: 10_000, actor: "user" }));
  route("GET", `${E}/document`, ({ project, query }) => readDoc(project().fs, query.path));
  route("PUT", `${E}/document`, SaveDocumentSchema, ({ project, body }) => {
    const fs = project().fs;
    const rel = fs.rel(body.path, "user");
    const abs = fs.abs(rel, "user");
    const exists = existsSync(abs);
    if (exists && body.revision && sha1(readFileSync(abs, "utf8")) !== body.revision) throw new UserError("The file changed on disk since you opened it. Reload it or keep your copy.", 409);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body.content);
    return readDoc(fs, rel);
  });
  route("GET", `${E}/search`, ({ project, query }) => {
    const fs = project().fs;
    const q = query.q.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];
    let searched = 0;
    for (const f of fs.walk({ max: 10_000, actor: "user" }).files) {
      if (matches.length >= 500) break;
      if (isBinaryPath(f) || isSecretPath(f) || fs.size(f, "user") > 1_000_000) continue;
      searched++;
      readFileSync(fs.abs(f, "user"), "utf8").split("\n").forEach((text, i) => { if (matches.length < 500 && text.toLowerCase().includes(q)) matches.push({ path: f, line: i + 1, text: text.slice(0, 300) }); });
    }
    return { matches, searched, truncated: matches.length >= 500 };
  });
  route("POST", `${E}/folder`, FolderInSchema, ({ project, body }) => {
    const fs = project().fs;
    mkdirSync(fs.abs(body.path, "user"), { recursive: true });
    return { path: fs.rel(body.path, "user") };
  });
  route("GET", `${E}/item`, ({ project, query }) => item(project().fs, query.path));
  route("POST", `${E}/item/move`, MoveDocumentSchema, ({ project, body }) => {
    const fs = project().fs;
    if (item(fs, body.path).revision !== body.revision) throw new UserError("It changed since you selected it; refresh and try again", 409);
    const to = fs.abs(body.destination, "user");
    if (existsSync(to)) throw new UserError(`${body.destination} already exists`, 409);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(fs.abs(body.path, "user"), to);
    return item(fs, body.destination);
  });
  route("POST", `${E}/item/trash`, FileVersionSchema, ({ project, body }) => {
    const fs = project().fs;
    if (item(fs, body.path).revision !== body.revision) throw new UserError("It changed since you selected it; refresh and try again", 409);
    return { token: trash(fs, body.path, "user") };
  });
  route("POST", `${E}/item/restore/{token}`, ({ project, params }) => {
    const fs = project().fs;
    return item(fs, restore(fs, params.token).path);
  });
  route("GET", `${E}/items/trash`, ({ project }) => listTrash(project().fs));

  const P = E.replace("{workspace_id}", ":workspace_id");
  app.post(`${P}/asset`, async (req) => {
    const fs = project(reg, (req.params as Record<string, string>).workspace_id!).fs;
    const file = await req.file({ limits: { fileSize: 20_000_000 } });
    if (!file) throw new UserError("Attach a file");
    const rel = fs.rel(String((req.query as Record<string, string>).path ?? file.filename), "user");
    const abs = fs.abs(rel, "user");
    if (existsSync(abs)) throw new UserError(`${rel} already exists`, 409);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, await file.toBuffer());
    return item(fs, rel);
  });
  app.get(`${P}/download`, async (req, reply) => {
    const fs = project(reg, (req.params as Record<string, string>).workspace_id!).fs;
    const rel = fs.rel(String((req.query as Record<string, string>).path ?? ""), "user");
    const abs = fs.abs(rel, "user");
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound(rel);
    return sendFile(reply, abs, { "content-disposition": `attachment; filename="${path.basename(rel).replace(/"/g, "")}"` });
  });

  route("GET", `${E}/git`, ({ project }) => git.status(project().root));
  route("GET", `${E}/git/diff`, async ({ project, query }) => ({ patch: await git.diff(project().fs, query.path, !!query.staged) }));
  route("POST", `${E}/git/stage`, GitStageSchema, ({ project, body }) => git.stage(project().fs, body.path, body.staged));
  route("POST", `${E}/git/commit`, GitCommitSchema, ({ project, body }) => git.commit(project().root, body.message, body.expected_index));
  route("POST", `${E}/git/branch`, LocalBranchSchema, async ({ project, body }) => {
    await git.switchBranch(project().root, body.branch);
    return git.localEnvironment(project().root);
  });
  route("POST", `${E}/git/worktree`, LocalWorktreeSchema, async ({ project, body }) => {
    const { dir, branch } = await git.createWorktree(project().root, body.base_branch);
    const w = addWorkspace(reg, dir, `${project().name} (${branch.split("/").pop()})`);
    return { workspace: { id: w.id, name: w.name }, branch };
  });
  route("GET", `${E}/local-environment`, ({ project }) => git.localEnvironment(project().root));
  route("PUT", `${E}/local-environment`, LocalEnvironmentSchema, ({ project, body }) => {
    saveEnvironment(project().root, body.selected ?? null);
    return git.localEnvironment(project().root);
  });

  route("GET", `${E}/tasks`, ({ project }) => ({ tasks: projectTasks(project().fs), warnings: [] }));
  route("GET", `${E}/commands/current`, ({ project }) => processes(project().id).command.view());
  route("POST", `${E}/commands/current`, StartCommandSchema, ({ project, body }) => {
    const c = processes(project().id).command;
    c.start(project().fs, body.command, body.directory, body.timeout_seconds ?? 3600);
    return c.view();
  });
  route("DELETE", `${E}/commands/current`, ({ project }) => { const c = processes(project().id).command; c.stop(); return c.view(); });
  route("POST", `${E}/commands/input`, CommandInputSchema, ({ project, body }) => { const c = processes(project().id).command; c.input(body.text); return c.view(); });
  route("DELETE", `${E}/commands/output`, ({ project }) => { const c = processes(project().id).command; c.clear(); return c.view(); });
  route("GET", `${E}/server`, ({ project }) => processes(project().id).server.view());
  route("POST", `${E}/server`, StartServerSchema, ({ project, body }) => { const s = processes(project().id).server; s.start(project().fs, body.command, body.directory); return s.view(); });
  route("DELETE", `${E}/server`, ({ project }) => { const s = processes(project().id).server; s.stop(); return s.view(); });
}
