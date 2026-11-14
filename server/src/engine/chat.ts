/**
 * Direct chat with one agent: the same agent loop as the company, in "chat" mode (read the project, search the web,
 * keep notes; no file changes), streamed over the chat socket.
 */
import type { ChatEventMap, ChatTopic, MessageOut } from "@octopus/shared";
import { config } from "../config";
import { SHARED_MEMORY } from "../db/project";
import type { Registry } from "../db/registry";
import { skillsFor } from "../catalog/skills";
import { clip, newId, now, UserError } from "../lib/util";
import { toolbox } from "../tools";
import { Denied, type ToolContext } from "../tools/types";
import { projectOverview } from "../workspace/overview";
import type { Project } from "../workspace/projects";
import { agentLoop } from "./agent";
import { instructions } from "./prompts";

type Send = <T extends ChatTopic>(type: T, data: ChatEventMap[T]) => void;

export class ChatSession {
  private abort: AbortController | null = null;
  constructor(private p: Project, private reg: Registry, private sessionId: string, private send: Send) {}

  private session() {
    const s = this.p.db.sessions.get(this.sessionId);
    if (!s) throw new UserError("Chat not found", 404);
    return s;
  }

  stop() { this.abort?.abort(); }

  async regenerate() {
    const last = this.p.db.messages.find("session_id = ? AND run_id IS NULL", [this.sessionId], "created_at DESC")[0];
    if (last?.sender === "agent") { this.p.db.messages.remove(last.id); this.send("message_deleted", { id: last.id }); }
    await this.respond();
  }

  async userMessage(content: string, attachments: { filename: string; text: string }[] = []) {
    if (!content.trim()) return;
    const s = this.session();
    const files = attachments.map((a) => `\n\n--- ${a.filename} ---\n${clip(a.text, 40_000)}`).join("");
    const msg: MessageOut = { id: newId(), run_id: null, session_id: s.id, edge_id: null, from_agent_id: null, to_agent_id: s.agent_id, sender: "user",
      type: "chat", content: content + files, meta: { display_content: content, attachments: attachments.map((a) => a.filename) }, turn_no: 0, created_at: now() };
    this.p.db.messages.insert(msg);
    this.send("message_created", { message: msg });
    if (s.title === "New chat") this.p.db.sessions.update(s.id, { title: content.trim().split("\n")[0]!.slice(0, 60) });
    await this.respond();
  }

  private async respond() {
    const s = this.session();
    const agent = s.agent_id ? this.p.db.agents.get(s.agent_id) : undefined;
    if (!agent) throw new UserError("This chat's agent no longer exists", 404);
    const company = this.p.db.companies.get(s.company_id);
    const team = this.p.db.agents.find("company_id = ? AND active = 1", [s.company_id]);
    const history = this.p.db.messages.find("session_id = ? AND run_id IS NULL", [s.id], "created_at").slice(-30)
      .map((m) => ({ role: m.sender === "user" ? "user" : "assistant", content: m.content }));
    const messageId = newId();
    this.abort = new AbortController();
    this.send("stream_start", { message_id: messageId, agent_id: agent.id });
    const { tools } = await toolbox(this.reg, this.p.root, agent, "chat");
    const ctx: ToolContext = {
      agent, task: null, runId: `chat-${s.id}`, fs: this.p.fs, db: this.p.db, reg: this.reg, signal: this.abort.signal, team: () => team, seen: new Map(), shown: new Map(),
      guard: async () => { throw new Denied("not available in direct chat; ask the company in the main conversation"); },
      emit: () => {}, setStatus: (_st, activity) => this.send("status", { message_id: messageId, phase: "tool", detail: activity ?? "" }),
      recordFile: () => {}, consult: async () => "Teammates cannot be consulted from a direct chat.", ownerOf: () => null,
    };
    let text = "";
    try {
      const res = await agentLoop({
        reg: this.reg, model: agent.model || config.defaultModel, effort: agent.behavior.reasoning_effort, tools, ctx, maxRounds: 12, requireStop: false,
        instructions: instructions({ agent, company: company?.name ?? "the company", goal: "", team, overview: projectOverview(this.p.fs), skills: skillsFor(this.reg, agent),
          memory: { own: this.p.db.memory.find("agent_id = ?", [agent.id]), shared: this.p.db.memory.find("agent_id = ?", [SHARED_MEMORY]) } }, "chat"),
        input: history,
        events: {
          text: (delta) => { text += delta; this.send("token_stream", { message_id: messageId, delta }); },
          thinking: () => this.send("status", { message_id: messageId, phase: "thinking", detail: "Thinking…", model: agent.model }),
          thought: () => {}, toolStart: () => {}, toolArgs: () => {},
          toolCall: (_id, name, args) => { text = ""; this.send("stream_reset", { message_id: messageId }); this.send("tool_call", { message_id: messageId, call: { name, args } }); },
          toolResult: () => {}, usage: () => {}, beforeCall: async () => {},
        },
      });
      text = res.text || text;
    } catch (e) {
      if (!this.abort.signal.aborted) { this.send("error", { message: (e as Error).message }); if (!text) return; }
    }
    const reply: MessageOut = { id: messageId, run_id: null, session_id: s.id, edge_id: null, from_agent_id: agent.id, to_agent_id: null, sender: "agent",
      type: "chat", content: text || "(stopped)", meta: {}, turn_no: 0, created_at: now() };
    this.p.db.messages.insert(reply);
    this.send("stream_end", { message: reply });
  }
}
