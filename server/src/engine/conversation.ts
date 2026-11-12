/**
 * A conversation with the company. Each user message runs one cycle:
 *
 *   plan     the orchestrator reads the request and the project, answers directly, asks, or hires and creates tasks
 *   build    tasks run in parallel as their dependencies finish, each by its owner with their own tools
 *   review   every build is reviewed by someone else; requested changes go back to the author (bounded rounds)
 *   verify   the project's own tests and checks run; failures become fix tasks (bounded rounds)
 *   report   the orchestrator tells the user what was done, how it was verified and what is open
 *
 * Follow-ups continue the same conversation with the same team, tasks and files. Everything the user sees is an event.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_BUDGET, TERMINAL_STATUSES, type AgentOut, type AgentStatus, type Attachment, type EdgeOut, type MessageOut, type PendingApproval,
  type Question, type RunCreate, type RunEventMap, type RunStatus, type RunTopic, type TaskOut, type Usage, type WorkflowState,
} from "@octopus/shared";
import { config } from "../config";
import { SHARED_MEMORY, type RunRow } from "../db/project";
import type { Registry } from "../db/registry";
import { effectiveRoles, roleByKey } from "../catalog/roles";
import { skillsFor } from "../catalog/skills";
import type { Item } from "../llm/azure";
import { costParts } from "../llm/pricing";
import { connection } from "../llm/azure";
import { run as runProcess, safeEnv } from "../lib/proc";
import { clip, deferred, firstLine, newId, now, UserError } from "../lib/util";
import { parseCommand } from "../safety/commands";
import { toolbox, type Mode } from "../tools";
import { Denied, type GuardRequest, type HireSpec, type Stop, type TaskSpec, type ToolContext } from "../tools/types";
import { recordVersion, artifactOut } from "../workspace/artifacts";
import { projectOverview, verificationChecks } from "../workspace/overview";
import type { Project } from "../workspace/projects";
import { agentLoop, type LoopEvents } from "./agent";
import { publish } from "./bus";
import { agentFromRole, departmentColor, departmentsOf, freshName, placeHire, wire } from "./org";
import { instructions, libraryList, reviewBrief, taskBrief } from "./prompts";

interface Pending { question: Question; task_id: string | null }
interface RunState {
  agent_status: Record<string, AgentStatus>;
  activity: Record<string, string>;
  usage: Usage;
  history: { role: "user" | "assistant"; content: string }[];
  questions: Pending[];
  answers: Record<string, string>;
  feedback: Record<string, string>;
  revisions: Record<string, number>;
  files_by_task: Record<string, string[]>;
  always: string[];
  verify_rounds: number;
  workflow: WorkflowState;
  verification: { name: string; command: string; ok: boolean; output: string }[];
}
interface Inbound { content: string; display: string; to_agent_id: string | null; images: Item[] }
type Budget = typeof DEFAULT_BUDGET;

class Halt extends Error {}
const live = new Map<string, Conversation>();
const PHASES = [["plan", "Plan"], ["build", "Build"], ["review", "Review"], ["verify", "Verify"], ["report", "Report"]] as const;

function emptyUsage(b: Budget): Usage {
  return { tokens: 0, cost_usd: 0, turns: 0, max_turns: b.max_turns, max_tokens: b.max_tokens, max_cost_usd: b.max_cost_usd, timeout_s: b.timeout_s,
    active_seconds: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, llm_calls: 0, per_agent: {}, per_agent_cost: {},
    cost_breakdown: { input: 0, cached_input: 0, output: 0 } };
}

function initialState(b: Budget): RunState {
  return { agent_status: {}, activity: {}, usage: emptyUsage(b), history: [], questions: [], answers: {}, feedback: {}, revisions: {}, files_by_task: {},
    always: [], verify_rounds: 0, verification: [], workflow: { track: null, index: 0, ended: false, phases: PHASES.map(([key, title]) => ({ key, title, owner: null, status: "pending" })) } };
}

export class Conversation {
  row: RunRow;
  state: RunState;
  readonly budget: Budget;
  private team: AgentOut[] = [];
  private edges: EdgeOut[] = [];
  private tasks: TaskOut[] = [];
  private queue: Inbound[] = [];
  private driving = false;
  private abort = new AbortController();
  private gate: ReturnType<typeof deferred<void>> | null = null;
  private stepping = false;
  private approvals = new Map<string, { req: PendingApproval; done: (ok: boolean, reason: string) => void }>();
  private busy = new Set<string>();
  /** Images attached to the request being worked on, shown to everyone who works on it. */
  private requestImages: Item[] = [];
  private activeSince = 0;

  private constructor(readonly p: Project, readonly reg: Registry, row: RunRow) {
    this.row = row;
    this.budget = { ...DEFAULT_BUDGET, ...row.budget } as Budget;
    this.state = { ...initialState(this.budget), ...(row.state as Partial<RunState>) };
    this.tasks = p.db.tasks.find("run_id = ?", [row.id], "rowid");
    for (const t of this.tasks) if (t.status === "in_progress") t.status = "todo";
    this.loadTeam();
    this.startRequest();
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────────

  static get(p: Project, reg: Registry, runId: string): Conversation {
    const hit = live.get(runId);
    if (hit && hit.p === p) return hit;
    const row = p.db.runs.get(runId);
    if (!row) throw new UserError("Conversation not found", 404);
    const c = new Conversation(p, reg, row);
    live.set(runId, c);
    return c;
  }

  static isLive(runId: string) { return live.get(runId)?.driving ?? false; }
  static liveCount() { return [...live.values()].filter((c) => c.driving).length; }

  static create(p: Project, reg: Registry, body: RunCreate): Conversation {
    if (!connection(reg)) throw new UserError("Connect Azure OpenAI first: Settings → Model.", 412);
    const company = p.db.companies.get(body.company_id);
    if (!company) throw new UserError("Team not found", 404);
    const budget = { ...DEFAULT_BUDGET, ...(body.budget ?? {}) };
    const sessionId = body.session_id ?? newId();
    if (!body.session_id) p.db.sessions.insert({ id: sessionId, company_id: company.id, agent_id: null, mode: "company", title: firstLine(body.goal, 80), created_at: now() });
    const row: RunRow = {
      id: newId(), company_id: company.id, session_id: sessionId, goal: body.goal, status: "queued", mode: body.mode ?? "autonomous", budget,
      permission_level: reg.setting("approval_mode", "ask"), summary: "", halt_reason: "", report_md: "", tokens_used: 0, cost_usd: 0, turns: 0,
      outcome: null, snapshot: { agents: [], edges: [], departments: company.departments }, state: initialState(budget) as never,
      created_at: now(), started_at: null, ended_at: null,
    };
    p.db.runs.insert(row);
    const c = new Conversation(p, reg, row);
    live.set(row.id, c);
    c.submit(body.goal, body.attachments ?? [], null);
    return c;
  }

  private loadTeam() {
    this.team = this.p.db.agents.find("company_id = ? AND active = 1", [this.row.company_id]);
    this.edges = this.p.db.edges.find("company_id = ?", [this.row.company_id]);
    if (!this.team.length) {
      const role = roleByKey(this.reg, "orchestrator")!;
      const lead = agentFromRole(this.row.company_id, role, { name: "Octopus", department: "Executive", entry: true });
      this.p.db.agents.insert(lead);
      this.team = [lead];
    }
    const company = this.p.db.companies.get(this.row.company_id);
    this.row.snapshot = { agents: this.team, edges: this.edges, departments: company?.departments ?? {} };
  }

  get lead(): AgentOut {
    return this.team.find((a) => a.is_entry) ?? this.team.find((a) => a.is_manager && !a.reports_to) ?? this.team[0]!;
  }

  private get stopped() { return this.abort.signal.aborted; }

  // ── public API ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A user message: a new request, a follow-up, or the answer to a pending question. */
  submit(content: string, attachments: Attachment[], toAgentId: string | null): string {
    if (this.stopped && !this.driving) this.abort = new AbortController();
    const images = this.saveImages(attachments);
    const files = attachments.filter((a) => a.kind !== "image" && a.text).map((a) => `\n\n--- Attached file: ${a.filename} ---\n${clip(a.text!, 60_000)}`).join("");
    const mention = /(^|\s)@([\w-]+)/.exec(content)?.[2]?.toLowerCase();
    const target = toAgentId ?? this.team.find((a) => mention && a.name.toLowerCase() === mention)?.id ?? null;
    const pending = this.state.questions[0];
    const msg = this.post({ from: null, to: pending?.question.agent_id ?? target, sender: "user", type: pending ? "answer" : "task", content: content + files,
      meta: { display_content: content, images: images.map((i) => i.name), attachments: attachments.map((a) => a.filename) } });
    if (this.row.status !== "queued" && TERMINAL_STATUSES.includes(this.row.status)) this.emit("run_continued", { content: firstLine(content, 200) });
    this.queue.push({ content: content + files, display: content, to_agent_id: target, images: images.map((i) => ({ type: "input_image", image_url: i.url })) });
    void this.drive();
    return msg.id;
  }

  control(action: "pause" | "resume" | "step" | "stop") {
    if (action === "stop") return this.halt("Stopped by you", "cancelled");
    if (action === "pause") {
      this.gate ??= deferred<void>();
      this.setRunStatus("paused", { reason: "Paused" });
      return;
    }
    this.stepping = action === "step";
    const g = this.gate;
    this.gate = null;
    g?.resolve();
    if (this.row.status === "paused") this.setRunStatus("running");
    if (!this.driving) void this.drive();
  }

  resolveApproval(id: string, approved: boolean, scope: "once" | "always", reason = "") {
    const a = this.approvals.get(id);
    if (!a) throw new UserError("That approval is no longer pending", 409);
    if (approved && scope === "always" && a.req.details.key) this.state.always.push(a.req.details.key);
    a.done(approved, reason);
  }

  snapshot(): RunEventMap["snapshot"] {
    return { status: this.row.status, live: this.driving, agent_status: this.state.agent_status, activity: this.state.activity,
      pending_approval: [...this.approvals.values()][0]?.req ?? null, awaiting: this.state.questions[0]?.question ?? null, usage: this.state.usage };
  }

  // ── events and persistence ─────────────────────────────────────────────────────────────────────────────────────────

  emit<T extends RunTopic>(type: T, data: RunEventMap[T]) { publish(this.p.db, this.row.id, type, data); }

  private save() {
    const u = this.state.usage;
    if (this.activeSince) { u.active_seconds += (Date.now() - this.activeSince) / 1000; this.activeSince = Date.now(); }
    const done = this.tasks.filter((t) => t.status === "done").length;
    const blocked = this.tasks.filter((t) => t.status === "blocked").length;
    this.row = this.p.db.runs.update(this.row.id, {
      status: this.row.status, summary: this.row.summary, halt_reason: this.row.halt_reason, report_md: this.row.report_md,
      tokens_used: u.tokens, cost_usd: u.cost_usd, turns: u.turns, state: this.state as never, snapshot: this.row.snapshot,
      started_at: this.row.started_at, ended_at: this.row.ended_at,
      outcome: { tasks_total: this.tasks.length, tasks_done: done, tasks_blocked: blocked, tasks_open: this.tasks.length - done - blocked,
        files: Object.values(this.state.files_by_task).flat().length, errors: 0, final_report: !!this.row.report_md },
    })!;
  }

  private setRunStatus(status: RunStatus, extra: { reason?: string; summary?: string } = {}) {
    this.row.status = status;
    if (extra.reason !== undefined) this.row.halt_reason = extra.reason;
    if (extra.summary !== undefined) this.row.summary = extra.summary;
    const final = TERMINAL_STATUSES.includes(status) || status === "awaiting_user";
    if (status === "running" && !this.row.started_at) this.row.started_at = now();
    if (TERMINAL_STATUSES.includes(status)) this.row.ended_at = now();
    this.save();
    this.emit("run_status", { status, reason: extra.reason, summary: extra.summary, final, awaiting: this.state.questions[0]?.question ?? null,
      pending_approval: [...this.approvals.values()][0]?.req ?? null });
  }

  private setStatus(agent: AgentOut, status: AgentStatus, activity = "") {
    if (this.state.agent_status[agent.id] === status && this.state.activity[agent.id] === activity) return;
    this.state.agent_status[agent.id] = status;
    this.state.activity[agent.id] = activity;
    this.emit("agent_status", { agent_id: agent.id, status, activity });
  }

  private phase(key: string, status: "active" | "done" | "skipped" | "failed", owner?: string | null, summary?: string) {
    const wf = this.state.workflow;
    wf.phases = wf.phases.map((ph) => (ph.key === key ? { ...ph, status, owner: owner ?? ph.owner, summary: summary ?? ph.summary, loops: key === "review" || key === "verify" ? (ph.loops ?? 0) + (status === "active" && ph.status !== "active" ? 1 : 0) : ph.loops } : ph));
    wf.index = Math.max(0, wf.phases.findIndex((ph) => ph.status === "active"));
    this.emit("workflow_updated", { workflow: wf });
  }

  private edgeBetween(a: string, b: string, types: string[] = ["delegate", "review", "report", "consult"]) {
    return this.edges.find((e) => types.includes(e.type) && ((e.source_agent_id === a && e.target_agent_id === b) || (e.target_agent_id === a && e.source_agent_id === b)));
  }

  private post(m: { from: string | null; to: string | null; sender?: MessageOut["sender"]; type: string; content: string; meta?: Record<string, unknown> }): MessageOut {
    const e = m.from && m.to ? this.edgeBetween(m.from, m.to) : undefined;
    const msg: MessageOut = { id: newId(), run_id: this.row.id, session_id: this.row.session_id, edge_id: e?.id ?? null, from_agent_id: m.from, to_agent_id: m.to,
      sender: m.sender ?? (m.from ? "agent" : "user"), type: m.type, content: m.content, meta: m.meta ?? {}, turn_no: this.state.usage.turns, created_at: now() };
    this.p.db.messages.insert(msg);
    this.emit("message_created", { message: msg });
    if (e && m.from) this.emit("edge_activity", { edge_id: e.id, from_agent_id: m.from, type: e.type });
    return msg;
  }

  private saveImages(attachments: Attachment[]) {
    const dir = path.join(this.p.root, ".octopus", "attachments", this.row.id);
    return attachments.filter((a) => a.kind === "image" && a.data).map((a) => {
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now().toString(36)}-${a.filename.replace(/[^\w.-]/g, "_")}`;
      const data = a.data!.includes(",") ? a.data!.split(",")[1]! : a.data!;
      writeFileSync(path.join(dir, name), Buffer.from(data, "base64"));
      return { name, url: a.data!.startsWith("data:") ? a.data! : `data:${a.mime ?? "image/png"};base64,${data}` };
    });
  }

  private saveTask(t: TaskOut) {
    t.updated_at = now();
    this.p.db.tasks.upsert(t);
    const i = this.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) this.tasks[i] = t; else this.tasks.push(t);
    this.emit("task_updated", { task: t });
  }

  private newTask(spec: Omit<TaskOut, "id" | "run_id" | "key" | "status" | "result" | "attempts" | "updated_at">): TaskOut {
    const t: TaskOut = { ...spec, id: newId(), run_id: this.row.id, key: `T${this.tasks.length + 1}`, status: "todo", result: "", attempts: 0, updated_at: now() };
    this.saveTask(t);
    return t;
  }

  // ── guard: approvals and the safety policy ────────────────────────────────────────────────────────────────────────

  private async guard(agent: AgentOut, req: GuardRequest) {
    const mode = this.reg.setting<"ask" | "auto">("approval_mode", "ask");
    if (req.risk === "medium" && mode === "auto") return;
    if (this.state.always.includes(req.key)) return;
    const approval: PendingApproval = { id: newId(), agent_id: agent.id, kind: req.kind, summary: req.summary, preview: req.preview ?? "",
      details: { ...req.details, key: req.key }, risk: req.risk, level: mode };
    const decision = deferred<{ ok: boolean; reason: string }>();
    this.approvals.set(approval.id, { req: approval, done: (ok, reason) => decision.resolve({ ok, reason }) });
    const prev = this.state.agent_status[agent.id] ?? "idle";
    this.setStatus(agent, "awaiting_approval", req.summary);
    if (this.approvals.size === 1) this.emit("approval_requested", approval);
    const onAbort = () => decision.resolve({ ok: false, reason: "The conversation was stopped" });
    this.abort.signal.addEventListener("abort", onAbort, { once: true });
    const { ok, reason } = await decision.promise;
    this.abort.signal.removeEventListener("abort", onAbort);
    this.approvals.delete(approval.id);
    this.emit("approval_resolved", { id: approval.id, approved: ok, reason, agent_id: agent.id, kind: req.kind, summary: req.summary });
    const next = [...this.approvals.values()][0];
    if (next) this.emit("approval_requested", next.req);
    this.setStatus(agent, prev);
    if (!ok) throw new Denied(reason ? `the user declined: ${reason}` : "the user declined this action. Find another way or explain why it is needed.");
  }

  // ── running one agent ──────────────────────────────────────────────────────────────────────────────────────────────

  /** Usage when the current request started: limits apply to each request, so a follow-up always has room to work. */
  private requestStart = { turns: 0, tokens: 0, cost: 0, seconds: 0 };
  private startRequest() {
    const u = this.state.usage;
    this.requestStart = { turns: u.turns, tokens: u.tokens, cost: u.cost_usd, seconds: u.active_seconds };
  }

  private checkBudget() {
    const u = this.state.usage;
    const b = this.budget;
    const s = this.requestStart;
    if (u.turns - s.turns >= b.max_turns) throw new Halt(`Reached the limit of ${b.max_turns} model calls for this request`);
    if (u.tokens - s.tokens >= b.max_tokens) throw new Halt(`Reached the token limit (${b.max_tokens.toLocaleString()}) for this request`);
    if (u.cost_usd - s.cost >= b.max_cost_usd) throw new Halt(`Reached the cost limit ($${b.max_cost_usd}) for this request`);
    if (u.active_seconds - s.seconds >= b.timeout_s) throw new Halt(`Reached the time limit (${Math.round(b.timeout_s / 60)} min) for this request`);
  }

  private loopEvents(agent: AgentOut): LoopEvents {
    const first = new Set<string>();
    return {
      text: (delta) => { this.setStatus(agent, "speaking", "Writing"); this.emit("token_stream", { agent_id: agent.id, delta }); },
      thinking: (delta) => { this.setStatus(agent, "thinking", "Thinking"); this.emit("thinking_stream", { agent_id: agent.id, delta }); },
      thought: (text) => this.emit("thought", { agent_id: agent.id, text }),
      toolStart: (call) => { first.add(call.call_id); this.emit("token_stream", { agent_id: agent.id, delta: `\n{"action":"${call.name}",` }); },
      toolArgs: (id, delta) => {
        const d = first.has(id) ? delta.replace(/^\s*\{/, "") : delta;
        first.delete(id);
        this.emit("token_stream", { agent_id: agent.id, delta: d });
      },
      toolCall: (call_id, tool, args) => this.emit("tool_call", { call_id, agent_id: agent.id, tool, args }),
      toolResult: (call_id, tool, ok, output) => this.emit("tool_result", { call_id, agent_id: agent.id, tool, ok, output: clip(output, 4000) }),
      usage: (r) => {
        const u = this.state.usage;
        const parts = costParts(r.usage, connection(this.reg)?.options);
        u.turns++; u.llm_calls++;
        u.input_tokens += r.usage.input; u.cached_tokens += r.usage.cached; u.output_tokens += r.usage.output; u.reasoning_tokens += r.usage.reasoning;
        u.tokens += r.usage.input + r.usage.output;
        u.cost_usd += r.costUsd;
        u.cost_breakdown = { input: u.cost_breakdown.input + parts.input, cached_input: u.cost_breakdown.cached_input + parts.cached_input, output: u.cost_breakdown.output + parts.output };
        u.per_agent[agent.id] = (u.per_agent[agent.id] ?? 0) + r.usage.input + r.usage.output;
        u.per_agent_cost[agent.id] = (u.per_agent_cost[agent.id] ?? 0) + r.costUsd;
        this.save();
        this.emit("usage_update", u);
      },
      beforeCall: async () => {
        if (this.stopped) throw new Halt("Stopped");
        if (this.gate) await this.gate.promise;
        if (this.stepping || (this.row.mode === "step" && !this.gate)) {
          this.stepping = false;
          this.gate = deferred<void>();
          this.setRunStatus("paused", { reason: "Step mode: press Next step to continue" });
          await this.gate.promise;
        }
        this.checkBudget();
        this.setStatus(agent, "thinking", "Thinking");
      },
    };
  }

  private context(agent: AgentOut, task: TaskOut | null, planner?: ToolContext["planner"]): ToolContext {
    return {
      agent, task, runId: this.row.id, fs: this.p.fs, db: this.p.db, reg: this.reg, signal: this.abort.signal, planner,
      team: () => this.team, seen: new Map(),
      guard: (req) => this.guard(agent, req),
      emit: (type, data) => this.emit(type, data),
      setStatus: (status, activity) => this.setStatus(agent, status, activity),
      recordFile: (rel, before, after, note) => {
        const { row, lines, previous_lines } = recordVersion(this.p.db, { runId: this.row.id, path: rel, before, after, author: agent.id, note });
        if (task) this.state.files_by_task[task.id] = [...new Set([...(this.state.files_by_task[task.id] ?? []), rel])];
        this.emit("artifact_updated", { artifact: { ...artifactOut(row), created: before === null, lines, previous_lines } });
      },
      consult: (to, question) => this.consult(agent, to, question),
    };
  }

  private model(agent: AgentOut) { return this.budget.model || agent.model || config.defaultModel; }
  private effort(agent: AgentOut) { return this.budget.reasoning_effort !== "default" ? this.budget.reasoning_effort : agent.behavior.reasoning_effort; }

  private async turn(agent: AgentOut, mode: Mode, task: TaskOut | null, input: Item[], opts: { planner?: ToolContext["planner"]; maxRounds: number }) {
    const { tools, warnings } = await toolbox(this.reg, this.p.root, agent, mode);
    for (const w of warnings) this.emit("error", { message: w, kind: "warning", agent_id: agent.id });
    const company = this.p.db.companies.get(this.row.company_id);
    const system = instructions({
      agent, company: company?.name ?? "the company", goal: this.row.goal, team: this.team, overview: projectOverview(this.p.fs), skills: skillsFor(this.reg, agent),
      memory: { own: this.p.db.memory.find("agent_id = ?", [agent.id]), shared: this.p.db.memory.find("agent_id = ?", [SHARED_MEMORY]) },
    }, mode);
    this.emit("turn_started", { agent_id: agent.id, task_key: task?.key });
    try {
      return await agentLoop({ reg: this.reg, model: this.model(agent), effort: this.effort(agent), instructions: system, input, tools,
        ctx: this.context(agent, task, opts.planner), events: this.loopEvents(agent), maxRounds: opts.maxRounds, requireStop: mode !== "consult" && mode !== "report" });
    } finally {
      this.setStatus(agent, "idle");
    }
  }

  private async consult(from: AgentOut, to: AgentOut, question: string): Promise<string> {
    this.post({ from: from.id, to: to.id, type: "question", content: question, meta: { consult: true } });
    const res = await this.turn(to, "consult", null, [{ role: "user", content: `${from.name} (${from.role}) asks:\n\n${question}` }], { maxRounds: 8 });
    const answer = res.text || "(no answer)";
    this.post({ from: to.id, to: from.id, type: "answer", content: answer, meta: { consult: true } });
    return answer;
  }

  // ── staffing ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private findAgent(who: string | undefined | null): AgentOut | undefined {
    if (!who) return undefined;
    const q = who.trim().toLowerCase();
    return this.team.find((a) => a.id === who || a.name.toLowerCase() === q) ?? this.team.find((a) => a.name.toLowerCase().startsWith(q) || a.role.toLowerCase() === q);
  }

  hire(spec: HireSpec, by: AgentOut): AgentOut {
    if (this.team.length >= this.budget.max_agents) throw new UserError(`The team is at its limit of ${this.budget.max_agents} people. Assign the work to someone already on it.`);
    const roles = effectiveRoles(this.reg);
    const role = roles.find((r) => r.key === spec.role_key) ?? roles.find((r) => r.role.toLowerCase() === spec.title.toLowerCase()) ?? {
      ...roles.find((r) => r.key === "developer")!, key: "", role: spec.title, description: spec.reason, system_prompt: `You are an expert ${spec.title}.`, avatar: "bot", color: departmentColor(spec.department),
    };
    const manager = this.findAgent(spec.reports_to) ?? by;
    const agent = agentFromRole(this.row.company_id, role, {
      name: freshName(this.team.map((a) => a.name), spec.name || role.default_name), department: spec.department, manager: spec.manager,
      reports_to: manager.id, created_by: by.id, instructions: spec.instructions, title: spec.title,
    });
    placeHire(this.team, agent);
    const edges = wire([...this.team, agent], this.edges);
    this.p.db.tx(() => {
      this.p.db.agents.insert(agent);
      for (const e of edges) this.p.db.edges.insert(e);
      const company = this.p.db.companies.get(this.row.company_id)!;
      this.p.db.companies.update(company.id, { departments: departmentsOf([agent], company.departments), revision: company.revision + 1, updated_at: now() });
    });
    this.team.push(agent);
    this.edges.push(...edges);
    this.row.snapshot = { ...this.row.snapshot, agents: this.team, edges: this.edges };
    this.state.agent_status[agent.id] = "idle";
    this.emit("agent_created", { agent, edges, created_by: by.id, persisted: true, reason: spec.reason, department: { name: agent.department, color: departmentColor(agent.department) } });
    this.save();
    return agent;
  }

  /** Who reviews a piece of work: a review channel to the author, their department lead, a reviewer on the team, or a new tech lead. */
  private reviewerFor(author: AgentOut): AgentOut {
    const byChannel = this.edges.find((e) => e.type === "review" && e.target_agent_id === author.id && e.source_agent_id !== author.id);
    const assigned = byChannel && this.team.find((a) => a.id === byChannel.source_agent_id);
    if (assigned) return assigned;
    const lead = this.team.find((a) => a.id === author.reports_to && a.is_manager && a.id !== this.lead.id && a.tools.file_read !== false);
    if (lead && lead.id !== author.id) return lead;
    const reviewer = this.team.find((a) => a.id !== author.id && ["techlead", "architect", "security"].includes(a.behavior.template_key ?? ""));
    if (reviewer) return reviewer;
    return this.hire({ role_key: "techlead", title: "Tech Lead / Reviewer", department: "Engineering", reason: "Every change gets an independent review", manager: false }, this.lead);
  }

  // ── the cycle ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async drive() {
    if (this.driving) return;
    this.driving = true;
    this.activeSince = Date.now();
    try {
      if (this.row.status !== "running") this.setRunStatus("running", { reason: "" });
      while (!this.stopped) {
        const msg = this.queue.shift();
        const pending = this.state.questions[0];
        let worked = false;
        if (msg) this.startRequest();
        if (msg && pending) {
          this.state.questions.shift();
          if (pending.task_id) {
            this.state.answers[pending.task_id] = msg.content;
            const t = this.tasks.find((x) => x.id === pending.task_id);
            if (t) this.saveTask({ ...t, status: "todo" });
            this.askNext();
          } else {
            this.state.history.push({ role: "assistant", content: `Question: ${pending.question.question}` }, { role: "user", content: msg.content });
            if ((await this.plan(msg)) !== "work") continue;
          }
        } else if (msg) {
          this.state.history.push({ role: "user", content: msg.display });
          this.requestImages = msg.images;
          this.loadTeam();
          const direct = msg.to_agent_id && msg.to_agent_id !== this.lead.id ? this.team.find((a) => a.id === msg.to_agent_id) : undefined;
          if (direct) {
            this.newTask({ title: firstLine(msg.display, 80), description: msg.content, acceptance_criteria: "Do what the user asked; verify it.", assignee_agent_id: direct.id,
              kind: direct.tools.file_write === false ? "research" : "build", depends_on: [], created_by: null });
          } else if ((await this.plan(msg)) !== "work") continue;
        } else if (!this.tasks.some((t) => t.status === "todo")) break;
        worked = await this.execute();
        if (this.state.questions.length) {
          if (!this.queue.length) { this.setRunStatus("awaiting_user", { reason: "Waiting for your answer" }); break; }
          continue;
        }
        if (worked || this.tasks.length) await this.report();
        if (!this.queue.length) break;
      }
    } catch (e) {
      if (e instanceof Halt || this.stopped) this.finishHalted(e instanceof Halt ? e.message : "Stopped");
      else {
        this.emit("error", { message: (e as Error).message, kind: "error" });
        this.setRunStatus("failed", { reason: (e as Error).message });
      }
    } finally {
      this.driving = false;
      if (this.row.status === "running" && !this.queue.length) {
        if (this.state.questions.length) this.setRunStatus("awaiting_user", { reason: "Waiting for your answer" });
        else this.setRunStatus(this.tasks.some((t) => t.status === "blocked") ? "incomplete" : "completed", { reason: "" });
      }
      this.save();
      if (this.queue.length) {
        if (this.stopped) this.abort = new AbortController();
        queueMicrotask(() => void this.drive());
      }
    }
  }

  private halt(reason: string, status: RunStatus = "incomplete") {
    this.queue = [];
    this.abort.abort();
    for (const a of this.approvals.values()) a.done(false, "The conversation was stopped");
    this.gate?.resolve();
    this.gate = null;
    if (!this.driving) this.finishHalted(reason, status);
    else this.pendingHalt = { reason, status };
  }
  private pendingHalt: { reason: string; status: RunStatus } | null = null;

  private finishHalted(reason: string, status: RunStatus = "incomplete") {
    const h = this.pendingHalt ?? { reason, status };
    this.pendingHalt = null;
    for (const t of this.tasks) if (t.status === "in_progress") this.saveTask({ ...t, status: "todo" });
    for (const a of this.team) this.setStatus(a, "idle");
    this.setRunStatus(h.status, { reason: h.reason, summary: h.status === "cancelled" ? "Stopped. Send a message to continue." : `${h.reason}. Send a message to continue.` });
  }

  private orchestratorInput(msg: Inbound, note = ""): Item[] {
    const history = this.state.history.slice(0, -1).slice(-12).map((h) => `**${h.role === "user" ? "User" : "You"}:** ${clip(h.content, 3000)}`).join("\n\n");
    const open = this.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const done = this.tasks.filter((t) => t.status === "done").slice(-15);
    const who = (id: string | null) => this.team.find((a) => a.id === id)?.name ?? "?";
    const context = [
      history && `## Conversation so far\n${history}`,
      done.length && `## Finished tasks\n${done.map((t) => `- ${t.key} ${t.title} (${who(t.assignee_agent_id)}): ${firstLine(t.result, 200)}`).join("\n")}`,
      open.length && `## Open tasks\n${open.map((t) => `- ${t.key} [${t.status}] ${t.title} (${who(t.assignee_agent_id)})${t.result ? `: ${firstLine(t.result, 200)}` : ""}`).join("\n")}`,
      `## Role library (for hire_agent)\n${libraryList(effectiveRoles(this.reg))}`,
      `## Limits\nTeam: ${this.team.length} of at most ${this.budget.max_agents} people. Tasks run ${this.budget.max_concurrency} at a time.`,
      note,
    ].filter(Boolean).join("\n\n");
    return [
      { role: "developer", content: context },
      { role: "user", content: msg.images.length ? [{ type: "input_text", text: msg.content }, ...msg.images] : msg.content },
    ];
  }

  /** The orchestrator's planning turn. Returns what happened. */
  private async plan(msg: Inbound, midRun = false): Promise<"work" | "replied" | "asked"> {
    const note = midRun ? "The team is already working on the open tasks above. Adjust the plan for this new message (add tasks), or answer it with reply_to_user." : "";
    const lead = this.lead;
    this.phase("plan", "active", lead.id);
    const before = this.tasks.length;
    const planner = {
      hire: (spec: HireSpec) => this.hire(spec, lead),
      tasks: () => this.tasks,
      addTask: (spec: TaskSpec) => {
        const assignee = this.findAgent(spec.assignee);
        if (!assignee) throw new UserError(`Nobody called ${spec.assignee}. Hire them first or pick someone on the team.`);
        if (assignee.id === lead.id) throw new UserError("Assign the work to a specialist; you lead and review.");
        const deps = spec.depends_on.filter((k) => this.tasks.some((t) => t.key === k));
        const t = this.newTask({ title: spec.title, description: spec.description, acceptance_criteria: spec.acceptance_criteria, assignee_agent_id: assignee.id,
          kind: spec.kind, depends_on: deps, created_by: lead.id });
        this.post({ from: lead.id, to: assignee.id, type: "task", content: `**${t.title}**\n\n${t.description}`, meta: { task_id: t.key } });
        return t;
      },
    };
    const res = await this.turn(lead, "orchestrator", null, this.orchestratorInput(msg, note), { planner, maxRounds: 30 });
    const stop = res.stop;
    if (stop?.kind === "ask") {
      this.state.questions.push({ question: { agent_id: lead.id, question: stop.question, options: stop.options, allow_other: true }, task_id: null });
      if (this.state.questions.length === 1) this.askNext();
      this.phase("plan", "active", lead.id, "Waiting for your answer");
      if (!midRun) this.setRunStatus("awaiting_user", { reason: "Waiting for your answer" });
      return "asked";
    }
    if (stop?.kind === "plan_ready" || (this.tasks.length > before && stop?.kind !== "reply")) {
      const note2 = stop?.kind === "plan_ready" ? stop.note : res.text;
      if (note2) this.post({ from: lead.id, to: null, type: "decision", content: note2 });
      this.phase("plan", "done", lead.id, firstLine(note2 ?? "", 120));
      return "work";
    }
    const reply = stop?.kind === "reply" ? stop.message : res.text || "I could not decide on a plan. Could you rephrase the request?";
    this.phase("plan", "done", lead.id);
    if (midRun) this.post({ from: lead.id, to: null, type: "answer", content: reply });
    else this.finishCycle(reply, "completed");
    return "replied";
  }

  private askNext() {
    const q = this.state.questions[0];
    if (!q) return;
    this.post({ from: q.question.agent_id, to: null, type: "question", content: q.question.question, meta: { awaiting_input: true, options: q.question.options } });
  }

  /** Run tasks until nothing more can start. Returns whether any work was done. */
  private async execute(): Promise<boolean> {
    let worked = false;
    const running = new Map<string, Promise<void>>();
    for (;;) {
      if (this.stopped) break;
      if (this.queue.length && !this.state.questions.length) {
        const msg = this.queue.shift()!;
        this.state.history.push({ role: "user", content: msg.display });
        await this.plan(msg, true);
      }
      const done = new Set(this.tasks.filter((t) => t.status === "done").map((t) => t.key));
      const inReview = new Set(this.tasks.filter((t) => t.status === "review").map((t) => t.key));
      const failed = new Set(this.tasks.filter((t) => ["blocked", "cancelled"].includes(t.status)).map((t) => t.key));
      for (const t of this.tasks) {
        if (t.status === "todo" && t.depends_on.some((k) => failed.has(k))) this.saveTask({ ...t, status: "blocked", result: `Blocked: depends on ${t.depends_on.filter((k) => failed.has(k)).join(", ")}, which could not be finished.` });
      }
      const ready = this.tasks.filter((t) => t.status === "todo" && !this.busy.has(t.assignee_agent_id ?? "")
        && t.depends_on.every((k) => done.has(k) || (t.kind === "review" && inReview.has(k))));
      for (const t of ready) {
        if (running.size >= this.budget.max_concurrency) break;
        if (this.busy.has(t.assignee_agent_id ?? "")) continue;
        worked = true;
        this.busy.add(t.assignee_agent_id ?? "");
        const p = this.runTask(t).finally(() => { running.delete(t.id); this.busy.delete(t.assignee_agent_id ?? ""); });
        running.set(t.id, p);
      }
      if (!running.size) {
        if (worked && !this.state.questions.length && (await this.verify())) continue;
        break;
      }
      await Promise.race(running.values());
    }
    await Promise.allSettled(running.values());
    if (this.pendingHalt) throw new Halt(this.pendingHalt.reason);
    return worked;
  }

  private async runTask(t: TaskOut) {
    const agent = this.team.find((a) => a.id === t.assignee_agent_id);
    if (!agent) { this.saveTask({ ...t, status: "blocked", result: "Its owner is no longer on the team." }); return; }
    const task = { ...t, status: "in_progress" as const, attempts: t.attempts + 1 };
    this.saveTask(task);
    this.phase(task.kind === "review" ? "review" : "build", "active");
    const deps = this.tasks.filter((d) => task.depends_on.includes(d.key));
    const mode: Mode = task.kind === "review" ? "reviewer" : "worker";
    const work = task.kind === "review" ? this.tasks.find((x) => x.key === task.depends_on[0]) : undefined;
    const brief = task.kind === "review" && work
      ? reviewBrief(work, { goal: this.row.goal, author: this.team.find((a) => a.id === work.assignee_agent_id)?.name ?? "a teammate", summary: work.result,
        files: this.state.files_by_task[work.id] ?? [], round: (this.state.revisions[work.id] ?? 0) + 1 })
      : taskBrief(task, { goal: this.row.goal, deps, team: this.team, feedback: this.state.feedback[task.id], answer: this.state.answers[task.id] });
    let stop: Stop | null = null;
    let text = "";
    let exhausted = false;
    try {
      const content = this.requestImages.length ? [{ type: "input_text", text: brief }, ...this.requestImages] : brief;
      const res = await this.turn(agent, mode, task, [{ role: "user", content }], { maxRounds: mode === "reviewer" ? 30 : 60 });
      stop = res.stop;
      text = res.text;
      exhausted = !!res.exhausted;
    } catch (e) {
      if (e instanceof Halt || this.stopped) { this.pendingHalt ??= { reason: e instanceof Halt ? e.message : "Stopped", status: this.stopped && !(e instanceof Halt) ? "cancelled" : "incomplete" }; this.abort.abort(); return; }
      const message = (e as Error).message;
      this.emit("error", { message: `${agent.name}: ${message}`, kind: "error", agent_id: agent.id });
      if (task.attempts < 2 && !(e instanceof UserError && /not connected|401|403|404/.test(message))) { this.saveTask({ ...task, status: "todo" }); return; }
      this.saveTask({ ...task, status: "blocked", result: `Failed: ${message}` });
      return;
    }
    try {
      await this.settle(task, agent, stop, text, exhausted);
    } catch (e) {
      this.emit("error", { message: `${agent.name}: ${(e as Error).message}`, kind: "error", agent_id: agent.id });
      this.saveTask({ ...task, status: "blocked", result: `Could not be completed: ${(e as Error).message}` });
    }
  }

  /** Apply how a task ended: done, review, fix round, question or blocked. */
  private async settle(task: TaskOut, agent: AgentOut, stop: Stop | null, text: string, exhausted = false) {
    const lead = this.lead;
    if (stop?.kind === "ask") {
      this.saveTask({ ...task, status: "waiting", result: `Waiting for the user: ${stop.question}` });
      this.state.questions.push({ question: { agent_id: agent.id, question: stop.question, options: stop.options, allow_other: true }, task_id: task.id });
      if (this.state.questions.length === 1) this.askNext();
      return;
    }
    if (task.kind === "review" && stop?.kind !== "review" && stop?.kind !== "block" && task.attempts < 2) {
      this.saveTask({ ...task, status: "todo" }); // the reviewer did not give a verdict: ask again
      return;
    }
    if (stop?.kind === "block" || (!stop && (exhausted || !text || task.kind === "review"))) {
      const reason = stop?.kind === "block" ? stop.reason : task.kind === "review" ? "The reviewer did not give a verdict." : exhausted ? "Ran out of steps before finishing." : "Stopped without finishing.";
      this.saveTask({ ...task, status: "blocked", result: reason });
      const work = task.kind === "review" ? this.tasks.find((x) => x.key === task.depends_on[0]) : undefined;
      if (work?.status === "review") this.saveTask({ ...work, status: "blocked", result: `${work.result}\n\nNot reviewed: ${reason}` });
      this.post({ from: agent.id, to: lead.id, type: "status_update", content: `Blocked on ${task.key}: ${reason}`, meta: { task_id: task.key } });
      return;
    }
    if (task.kind === "review") {
      const work = this.tasks.find((x) => x.key === task.depends_on[0]);
      if (stop?.kind !== "review") return;
      const { verdict, comments } = stop;
      this.saveTask({ ...task, status: "done", result: `${verdict === "approve" ? "Approved" : "Changes requested"}: ${comments}` });
      if (!work) return;
      const rounds = this.state.revisions[work.id] ?? 0;
      this.post({ from: agent.id, to: work.assignee_agent_id, type: "review_result", content: comments,
        meta: { verdict, task_id: work.key, review: { revisions: rounds, max_revisions: this.budget.max_revisions } } });
      if (verdict === "approve" || rounds >= this.budget.max_revisions) {
        this.saveTask({ ...work, status: "done", result: verdict === "approve" ? work.result : `${work.result}\n\nOpen review comments (revision limit reached): ${comments}` });
        this.phase("review", "done", agent.id);
        return;
      }
      this.state.revisions[work.id] = rounds + 1;
      this.state.feedback[work.id] = comments;
      this.saveTask({ ...work, status: "todo", kind: "fix" as const, title: work.title.startsWith("Revise: ") ? work.title : `Revise: ${work.title}` });
      return;
    }
    const summary = stop?.kind === "complete" ? `${stop.summary}${stop.verification ? `\n\nVerified: ${stop.verification}` : ""}` : text;
    const changed = (this.state.files_by_task[task.id] ?? []).length > 0;
    this.post({ from: agent.id, to: agent.reports_to ?? lead.id, type: "status_update", content: summary, meta: { task_id: task.key } });
    if (this.budget.review && (task.kind === "build" || task.kind === "fix") && changed) {
      this.saveTask({ ...task, status: "review", result: summary });
      const reviewer = this.reviewerFor(agent);
      this.newTask({ title: `Review ${task.key}: ${task.title.replace(/^Revise: /, "")}`, description: `Review ${agent.name}'s work on ${task.key}.`, acceptance_criteria: "",
        assignee_agent_id: reviewer.id, kind: "review", depends_on: [task.key], created_by: lead.id });
      this.post({ from: agent.id, to: reviewer.id, type: "review_request", content: `Please review ${task.key}: ${task.title}`, meta: { task_id: task.key } });
      return;
    }
    this.saveTask({ ...task, status: "done", result: summary });
  }

  /** Run the project's own checks after changes. Returns true when fix tasks were created. */
  private async verify(): Promise<boolean> {
    if (!this.budget.verify) return false;
    const changedTasks = this.tasks.filter((t) => (t.kind === "build" || t.kind === "fix") && t.status === "done" && (this.state.files_by_task[t.id] ?? []).length);
    if (!changedTasks.length) return false;
    const checks = verificationChecks(this.p.fs);
    if (!checks.length) { this.phase("verify", "skipped", null, "The project has no automated checks"); return false; }
    const lead = this.lead;
    this.phase("verify", "active", lead.id);
    const results: RunState["verification"] = [];
    for (const c of checks) {
      if (this.stopped) return false;
      const callId = newId();
      this.setStatus(lead, "running", c.command);
      this.emit("tool_call", { call_id: callId, agent_id: lead.id, tool: "run_code", args: { command: c.command, cwd: c.directory } });
      const res = await runProcess(parseCommand(c.command), { cwd: this.p.fs.abs(c.directory === "." ? "" : c.directory), env: safeEnv(), timeoutMs: 300_000, maxOutput: 30_000, signal: this.abort.signal });
      const ok = res.code === 0 && !res.timedOut;
      results.push({ name: c.name, command: c.command, ok, output: clip(res.output, 6000) });
      this.emit("tool_result", { call_id: callId, agent_id: lead.id, tool: "run_code", ok, output: clip(res.output, 4000) });
    }
    this.setStatus(lead, "idle");
    this.state.verification = results;
    const failures = results.filter((r) => !r.ok);
    if (!failures.length) { this.phase("verify", "done", lead.id, `${results.length} check${results.length > 1 ? "s" : ""} passed`); return false; }
    if (this.state.verify_rounds >= this.budget.max_revisions) { this.phase("verify", "failed", lead.id, "Checks still failing"); return false; }
    this.state.verify_rounds++;
    const last = changedTasks[changedTasks.length - 1]!;
    const owner = this.team.find((a) => a.id === last.assignee_agent_id) ?? lead;
    const report = failures.map((f) => `### ${f.name} (\`${f.command}\`) failed\n\`\`\`\n${f.output}\n\`\`\``).join("\n\n");
    const fix = this.newTask({ title: `Fix failing checks`, description: `The project's checks fail after the team's changes. Find the cause and fix it. If a failure was already there before this work and is unrelated, leave it and say so.\n\n${report}`,
      acceptance_criteria: failures.map((f) => `- \`${f.command}\` passes`).join("\n"), assignee_agent_id: owner.id, kind: "fix", depends_on: [], created_by: lead.id });
    this.post({ from: lead.id, to: owner.id, type: "task", content: `Checks failed: ${failures.map((f) => f.name).join(", ")}. Please fix (${fix.key}).`, meta: { task_id: fix.key } });
    return true;
  }

  private async report() {
    const lead = this.lead;
    this.phase("report", "active", lead.id);
    const who = (id: string | null) => this.team.find((a) => a.id === id)?.name ?? "?";
    const tasks = this.tasks.map((t) => `- ${t.key} [${t.status}] ${t.title} (${who(t.assignee_agent_id)}): ${clip(t.result, 800)}`).join("\n");
    const files = [...new Set(Object.values(this.state.files_by_task).flat())];
    const checks = this.state.verification.map((v) => `- ${v.name}: ${v.ok ? "passed" : "failed"}`).join("\n");
    const prompt = [
      `The team has finished working on the latest request. Write your reply to the user now, in Markdown, without calling tools.`,
      `Lead with the outcome in one or two sentences. Then: what changed and where (files), how it was verified, how to run or try it, and anything open or worth deciding next. Be specific and honest; do not oversell. Keep it short.`,
      `## Tasks\n${tasks}`, files.length ? `## Files changed\n${files.map((f) => `- ${f}`).join("\n")}` : "", checks ? `## Automated checks\n${checks}` : "",
    ].filter(Boolean).join("\n\n");
    let text = "";
    try {
      const res = await this.turn(lead, "report", null, [{ role: "user", content: `${this.state.history.findLast((h) => h.role === "user")?.content ?? this.row.goal}` }, { role: "developer", content: prompt }], { maxRounds: 2 });
      text = res.text;
    } catch (e) {
      if (e instanceof Halt || this.stopped) throw e;
      text = `The work is done, but I could not write the summary (${(e as Error).message}).\n\n${tasks}`;
    }
    const blocked = this.tasks.some((t) => t.status === "blocked") || this.state.verification.some((v) => !v.ok);
    this.phase("report", "done", lead.id);
    this.finishCycle(text || "Done.", blocked ? "incomplete" : "completed", files);
  }

  private finishCycle(text: string, status: RunStatus, files: string[] = []) {
    const lead = this.lead;
    this.post({ from: lead.id, to: null, type: "final_report", content: text, meta: { files } });
    this.state.history.push({ role: "assistant", content: text });
    this.row.report_md = `${this.row.report_md ? `${this.row.report_md}\n\n---\n\n` : ""}## ${firstLine(this.state.history.findLast((h) => h.role === "user")?.content ?? this.row.goal, 100)}\n\n${text}`;
    for (const a of this.team) this.setStatus(a, a.id === lead.id ? "done" : "idle");
    this.state.workflow.ended = true;
    this.setRunStatus(status, { summary: firstLine(text, 300), reason: status === "incomplete" ? "Some tasks could not be finished" : "" });
    this.state.workflow = initialState(this.budget).workflow;
    this.state.verify_rounds = 0;
  }

  /** For deleting a conversation: stop it and forget it. */
  static discard(runId: string) {
    const c = live.get(runId);
    if (c) { c.abort.abort(); live.delete(runId); }
  }
}
