/**
 * WebSockets. The run socket sends a snapshot, replays every stored event after `last_seq`, then streams live events;
 * the browser sends follow-ups, approvals and controls on the same socket. The chat socket streams a direct chat.
 */
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { ApprovalInSchema, AttachmentSchema, RUN_ACTIONS, type RunClientMessage, type RunEventEnvelope } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { replay, subscribe } from "../engine/bus";
import { ChatSession } from "../engine/chat";
import { Conversation } from "../engine/conversation";
import { UserError } from "../lib/util";
import { project } from "../workspace/projects";

const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

function keepAlive(ws: WebSocket) {
  const t = setInterval(() => send(ws, { type: "ping", data: {} }), 20_000);
  ws.on("close", () => clearInterval(t));
}

export function wsRoutes(app: FastifyInstance, reg: Registry) {
  app.get("/ws/w/:workspace_id/runs/:run_id", { websocket: true }, (ws, req) => {
    const { workspace_id, run_id } = req.params as Record<string, string>;
    let conv: Conversation;
    try {
      conv = Conversation.get(project(reg, workspace_id!), reg, run_id!);
    } catch {
      ws.close(4404, "Not found");
      return;
    }
    const buffered: RunEventEnvelope[] = [];
    let replaying = true;
    let last = Number((req.query as Record<string, string>).last_seq ?? 0) || 0;
    const unsubscribe = subscribe(run_id!, (e) => {
      if (replaying) buffered.push(e);
      else if (!e.seq || e.seq > last) { if (e.seq) last = e.seq; send(ws, e); }
    });
    ws.on("close", unsubscribe);
    keepAlive(ws);
    send(ws, { type: "snapshot", run_id, data: conv.snapshot(), ts: new Date().toISOString() });
    for (const e of replay(conv.p.db, run_id!, last)) { send(ws, e); last = e.seq!; }
    send(ws, { type: "replay_done", run_id, data: { last_seq: last }, ts: new Date().toISOString() });
    replaying = false;
    for (const e of buffered) if (!e.seq || e.seq > last) { if (e.seq) last = e.seq; send(ws, e); }

    ws.on("message", (raw) => {
      let m: RunClientMessage;
      try { m = JSON.parse(String(raw)); } catch { return; }
      try {
        switch (m.type) {
          case "pong": return;
          case "interject": case "user_message": case "continue": {
            const attachments = AttachmentSchema.array().max(20).safeParse(m.attachments ?? []);
            if (typeof m.content !== "string" || !m.content.trim()) throw new UserError("Empty message");
            conv.submit(m.content.slice(0, 100_000), attachments.success ? attachments.data : [], m.to_agent_id ?? null);
            return;
          }
          case "control":
            if (!RUN_ACTIONS.includes(m.action)) throw new UserError("Unknown action");
            conv.control(m.action);
            return;
          case "approve": case "reject": {
            const a = ApprovalInSchema.parse({ ...m, approved: m.type === "approve" });
            conv.resolveApproval(a.approval_id, a.approved, a.scope ?? "once", a.reason);
            return;
          }
        }
      } catch (e) {
        send(ws, { type: "error", run_id, data: { message: (e as Error).message, kind: "client" }, ts: new Date().toISOString() });
      }
    });
  });

  // Agents' browsers are headless; the run view shows their screenshots instead of a live stream.
  app.get("/ws/w/:workspace_id/runs/:run_id/browser/:agent_id", { websocket: true }, (ws) => {
    send(ws, { type: "status", live: false, reason: "Live view is not available; screenshots appear as the agent works." });
    ws.close(4404, "No live view");
  });

  app.get("/ws/w/:workspace_id/chat/:session_id", { websocket: true }, (ws, req) => {
    const { workspace_id, session_id } = req.params as Record<string, string>;
    let chat: ChatSession;
    try {
      const p = project(reg, workspace_id!);
      if (!p.db.sessions.get(session_id!)) throw new Error("missing");
      chat = new ChatSession(p, reg, session_id!, (type, data) => send(ws, { type, data }));
    } catch {
      ws.close(4404, "Not found");
      return;
    }
    keepAlive(ws);
    ws.on("close", () => chat.stop());
    ws.on("message", (raw) => {
      let m: { type: string; content?: string; attachments?: { filename: string; text: string }[] };
      try { m = JSON.parse(String(raw)); } catch { return; }
      const fail = (e: unknown) => send(ws, { type: "error", data: { message: (e as Error).message } });
      if (m.type === "user_message") chat.userMessage(String(m.content ?? ""), (m.attachments ?? []).slice(0, 10)).catch(fail);
      else if (m.type === "stop") chat.stop();
      else if (m.type === "regenerate") chat.regenerate().catch(fail);
    });
  });
}
