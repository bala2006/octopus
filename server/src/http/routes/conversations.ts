/** Conversations with the company (runs), direct chats (sessions), and their files, reports and downloads. */
import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ApprovalInSchema, FollowUpSchema, RevertInSchema, RUN_ACTIONS, RunCreateSchema, SessionInSchema, SessionPatchSchema,
  type RunAction, type RunDetail, type RunOut,
} from "@octopus/shared";
import type { RunRow } from "../../db/project";
import type { Registry } from "../../db/registry";
import { replay } from "../../engine/bus";
import { Conversation } from "../../engine/conversation";
import { newId, notFound, now, UserError } from "../../lib/util";
import { zip } from "../../lib/zip";
import { artifactOut, artifactVersion, listArtifacts, revertFile } from "../../workspace/artifacts";
import { project } from "../../workspace/projects";
import type { RouteFn } from "../router";
import { sendFile } from "./files";

const runOut = ({ report_md: _r, snapshot: _s, state: _st, ...r }: RunRow): RunOut => r;
const runDetail = (r: RunRow): RunDetail => r;

export function conversationRoutes(route: RouteFn, app: FastifyInstance, reg: Registry) {
  const W = "/api/v1/w/{workspace_id}" as const;
  const runOf = (wid: string, rid: string) => {
    const p = project(reg, wid);
    const row = p.db.runs.get(rid);
    if (!row) throw notFound("Conversation");
    return { p, row };
  };

  route("GET", `${W}/runs`, ({ project, query }) => {
    const db = project().db;
    const rows = query.company_id ? db.runs.find("company_id = ?", [query.company_id], "created_at DESC") : db.runs.find("1=1", [], "created_at DESC");
    return rows.map(runOut);
  });
  route("POST", `${W}/runs`, RunCreateSchema, ({ project, body }) => runDetail(Conversation.create(project(), reg, body).row));
  route("GET", `${W}/runs/{run_id}`, ({ params }) => {
    const { p, row } = runOf(params.workspace_id, params.run_id);
    return runDetail(Conversation.isLive(row.id) ? Conversation.get(p, reg, row.id).row : row);
  });
  route("DELETE", `${W}/runs/{run_id}`, ({ params }) => {
    const { p, row } = runOf(params.workspace_id, params.run_id);
    Conversation.discard(row.id);
    p.db.tx(() => {
      for (const t of ["messages", "tasks", "run_events"]) p.db.db.run(`DELETE FROM ${t} WHERE run_id = ?`, row.id);
      p.db.runs.remove(row.id);
    });
    return { ok: true };
  });
  route("POST", `${W}/runs/{run_id}/control/{action}`, ({ params }) => {
    if (!RUN_ACTIONS.includes(params.action as RunAction)) throw new UserError("Unknown action");
    const { p, row } = runOf(params.workspace_id, params.run_id);
    const c = Conversation.get(p, reg, row.id);
    c.control(params.action as RunAction);
    return runOut(c.row);
  });
  route("POST", `${W}/runs/{run_id}/approve`, ApprovalInSchema, ({ params, body }) => {
    const { p, row } = runOf(params.workspace_id, params.run_id);
    Conversation.get(p, reg, row.id).resolveApproval(body.approval_id, body.approved, body.scope ?? "once", body.reason);
    return { ok: true };
  });
  route("POST", `${W}/runs/{run_id}/continue`, FollowUpSchema, ({ params, body }) => {
    const { p, row } = runOf(params.workspace_id, params.run_id);
    return { ok: true, message_id: Conversation.get(p, reg, row.id).submit(body.content, body.attachments ?? [], body.to_agent_id ?? null) };
  });
  route("GET", `${W}/runs/{run_id}/messages`, ({ params }) => runOf(params.workspace_id, params.run_id).p.db.messages.find("run_id = ?", [params.run_id], "created_at"));
  route("GET", `${W}/runs/{run_id}/tasks`, ({ params }) => runOf(params.workspace_id, params.run_id).p.db.tasks.find("run_id = ?", [params.run_id]));
  route("GET", `${W}/runs/{run_id}/events`, ({ params, query }) => replay(runOf(params.workspace_id, params.run_id).p.db, params.run_id, query.after ?? 0, query.limit ?? 5000)
    .map((e) => ({ id: e.seq!, run_id: e.run_id, type: e.type, payload: e.data, created_at: e.ts })));
  route("GET", `${W}/runs/{run_id}/artifacts`, ({ params, query }) => listArtifacts(runOf(params.workspace_id, params.run_id).p.db, params.run_id, !!query.all_versions));
  route("GET", `${W}/runs/{run_id}/artifacts/file`, ({ params, query }) => {
    const { p } = runOf(params.workspace_id, params.run_id);
    const row = artifactVersion(p.db, p.fs.rel(query.path), query.version);
    return { ...artifactOut(row), content: row.content ?? "" };
  });
  route("POST", `${W}/runs/{run_id}/artifacts/revert`, RevertInSchema, ({ params, body }) => {
    const { p, row } = runOf(params.workspace_id, params.run_id);
    const rel = p.fs.rel(body.path);
    const version = revertFile(p.db, p.fs, row.id, rel, body.to_version ?? 0);
    return { status: artifactVersion(p.db, rel, version).deleted ? "deleted" as const : "restored" as const, path: rel, version };
  });

  // binary and text downloads
  const wid = (req: { params: unknown }) => req.params as Record<string, string>;
  app.get(`${W.replace("{workspace_id}", ":workspace_id")}/runs/:run_id/report`, async (req, reply) => {
    const { workspace_id, run_id } = wid(req);
    const { row } = runOf(workspace_id!, run_id!);
    const md = `# ${row.goal.split("\n")[0]}\n\n${row.report_md || "_No report yet._"}\n`;
    reply.type("text/markdown; charset=utf-8");
    if ((req.query as Record<string, string>).download === "true") reply.header("content-disposition", `attachment; filename="octopus-report-${row.id}.md"`);
    return md;
  });
  app.get(`${W.replace("{workspace_id}", ":workspace_id")}/runs/:run_id/artifacts.zip`, async (req, reply) => {
    const { workspace_id, run_id } = wid(req);
    const { p } = runOf(workspace_id!, run_id!);
    const files = listArtifacts(p.db, run_id!, false).filter((a) => !a.deleted).map((a) => ({ name: a.path, data: Buffer.from(artifactVersion(p.db, a.path, a.version).content ?? "") }));
    reply.type("application/zip").header("content-disposition", `attachment; filename="changes-${run_id}.zip"`);
    return zip(files);
  });
  const runFile = (folder: string) => async (req: { params: unknown }, reply: Parameters<typeof sendFile>[0]) => {
    const { workspace_id, run_id, name } = wid(req);
    const { p } = runOf(workspace_id!, run_id!);
    if (!/^[\w.-]+$/.test(name ?? "")) throw new UserError("Invalid name");
    const file = path.join(p.root, ".octopus", folder, run_id!, name!);
    if (!existsSync(file)) throw notFound("File");
    return sendFile(reply, file);
  };
  app.get(`${W.replace("{workspace_id}", ":workspace_id")}/runs/:run_id/attachments/:name`, runFile("attachments"));
  app.get(`${W.replace("{workspace_id}", ":workspace_id")}/runs/:run_id/browser/:name`, runFile("browser"));

  // direct chats
  route("GET", `${W}/sessions`, ({ project, query }) => project().db.sessions.find("company_id = ?", [query.company_id], "created_at DESC"));
  route("POST", `${W}/sessions`, SessionInSchema, ({ project, body }) => project().db.sessions.insert({
    id: newId(), company_id: body.company_id, agent_id: body.agent_id ?? null, mode: body.mode ?? "direct", title: body.title ?? "New chat", created_at: now(),
  }));
  route("PATCH", `${W}/sessions/{session_id}`, SessionPatchSchema, ({ project, params, body }) => {
    const s = project().db.sessions.update(params.session_id, { title: body.title });
    if (!s) throw notFound("Chat");
    return s;
  });
  route("DELETE", `${W}/sessions/{session_id}`, ({ project, params }) => {
    const db = project().db;
    db.db.run("DELETE FROM messages WHERE session_id = ? AND run_id IS NULL", params.session_id);
    db.sessions.remove(params.session_id);
    return { ok: true };
  });
  route("GET", `${W}/sessions/{session_id}/messages`, ({ project, params, query }) =>
    project().db.messages.find("session_id = ?", [params.session_id], "created_at").slice(-(query.limit ?? 500)));
  app.get(`${W.replace("{workspace_id}", ":workspace_id")}/sessions/:session_id/export`, async (req, reply) => {
    const { workspace_id, session_id } = wid(req);
    const db = project(reg, workspace_id!).db;
    const s = db.sessions.get(session_id!);
    if (!s) throw notFound("Chat");
    const agents = new Map(db.agents.find("company_id = ?", [s.company_id]).map((a) => [a.id, a.name]));
    const msgs = db.messages.find("session_id = ?", [s.id], "created_at");
    if ((req.query as Record<string, string>).format === "json") return { session: s, messages: msgs };
    reply.type("text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="chat-${s.id}.md"`);
    return `# ${s.title}\n\n${msgs.map((m) => `**${m.from_agent_id ? agents.get(m.from_agent_id) ?? "Agent" : "You"}:** ${m.content}`).join("\n\n")}\n`;
  });
}
