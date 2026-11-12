/** Project files as the team sees them, downloads, and the sandboxed preview of HTML apps. */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FileNode } from "@octopus/shared";
import type { Registry } from "../../db/registry";
import { notFound, UserError } from "../../lib/util";
import { zip } from "../../lib/zip";
import { isBinaryPath, isSecretPath, WORK_DIR } from "../../safety/paths";
import { project } from "../../workspace/projects";
import type { RouteFn } from "../router";

const MIME: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", svg: "image/svg+xml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf",
  md: "text/markdown", txt: "text/plain", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", mp3: "audio/mpeg",
  mp4: "video/mp4", webm: "video/webm", wav: "audio/wav", xml: "application/xml", csv: "text/csv",
};
export const mimeOf = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

export function sendFile(reply: FastifyReply, file: string, extraHeaders: Record<string, string> = {}) {
  const type = mimeOf(file);
  reply.header("content-type", type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type);
  reply.header("x-content-type-options", "nosniff");
  for (const [k, v] of Object.entries(extraHeaders)) reply.header(k, v);
  return reply.send(createReadStream(file));
}

export function fileRoutes(route: RouteFn, app: FastifyInstance, reg: Registry) {
  const W = "/api/v1/w/{workspace_id}" as const;
  const nodes = (wid: string): { files: FileNode[]; truncated: boolean } => {
    const p = project(reg, wid);
    const { files, truncated } = p.fs.walk({ max: 5000, actor: "agent" });
    const touched = new Set(p.db.db.all<{ path: string }>("SELECT DISTINCT path FROM artifacts").map((r) => r.path));
    return { truncated, files: files.map((f) => ({ path: f, size: p.fs.size(f), area: f.startsWith(`${WORK_DIR}/`) ? "work" : "project", modified: touched.has(f), generated: touched.has(f) })) };
  };
  route("GET", `${W}/files`, ({ params }) => nodes(params.workspace_id).files);
  route("GET", `${W}/tree`, ({ params, project }) => ({ ...nodes(params.workspace_id), root: project().root, name: project().name }));
  route("GET", `${W}/files/content`, ({ project, query }) => {
    const p = project();
    const rel = p.fs.rel(query.path);
    const abs = p.fs.abs(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound("File");
    if (isBinaryPath(rel)) throw new UserError("Binary file; use the preview", 415);
    const size = statSync(abs).size;
    if (size > 2_000_000) throw new UserError("File too large to show", 413);
    return { path: rel, content: readFileSync(abs, "utf8"), size };
  });

  const P = W.replace("{workspace_id}", ":workspace_id");
  app.get(`${P}/files.zip`, async (req, reply) => {
    const p = project(reg, (req.params as Record<string, string>).workspace_id!);
    const files = p.fs.walk({ max: 5000 }).files.filter((f) => !isSecretPath(f) && p.fs.size(f) < 20_000_000)
      .map((f) => ({ name: `${p.name}/${f}`, data: readFileSync(p.fs.abs(f, "user")) }));
    reply.type("application/zip").header("content-disposition", `attachment; filename="${p.name.replace(/[^\w.-]/g, "_")}.zip"`);
    return zip(files);
  });
  // Previews run in a CSP sandbox with an opaque origin: the page can run its scripts but cannot reach the Octopus API.
  const preview = async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as Record<string, string>;
    const p = project(reg, params.workspace_id!);
    let rel = p.fs.rel(decodeURIComponent(params["*"] ?? ""), "user");
    if (!rel || p.fs.isDir(rel)) rel = path.posix.join(rel, "index.html");
    if (isSecretPath(rel)) throw new UserError("Secrets are not served", 403);
    const abs = p.fs.abs(rel, "user");
    if (!existsSync(abs) || !statSync(abs).isFile()) throw notFound(rel);
    return sendFile(reply, abs, { "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:", "cache-control": "no-store" });
  };
  app.get(`${P}/preview/*`, preview);
  // a conversation's preview shows the project as it is now (its files live in the project folder)
  app.get(`${P}/runs/:run_id/preview/*`, preview);
}
