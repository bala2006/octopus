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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_BUDGET, SPECIALIST_NAMES, TERMINAL_STATUSES, type AgentOut, type AgentStatus, type Attachment, type EdgeOut, type Effort, type MessageOut, type PendingApproval,
  type Question, type Requirement, type RunCreate, type RunEventMap, type RunStatus, type RunTopic, type SpecialistName, type TaskOut, type Usage, type WorkflowState,
} from "@octopus/shared";
import { config } from "../config";
import { conversationName } from "./naming";
import { SHARED_MEMORY, type RunRow } from "../db/project";
import type { Registry } from "../db/registry";
import { effectiveRoles, MAIN_ROLE, roleByKey } from "../catalog/roles";
import { effectiveSkills, skillsFor } from "../catalog/skills";
import { canReview, canVerify, canWrite, kindOf, staffingError } from "../catalog/kinds";
import { addFindings, answerFindings, blockingOpen, renderFindings, settlePrior, type Finding, unresolvedBlocking } from "../lib/findings";
import type { Item } from "../llm/azure";
import { costParts } from "../llm/pricing";
import { connection, contextWindow } from "../llm/azure";
import { clip, deferred, firstLine, newId, now, sha1, sleep, UserError } from "../lib/util";
import { changedLines } from "../lib/diff";
import { endingNames, toolbox, type Mode } from "../tools";
import { Denied, type GuardRequest, type HireSpec, type Planner, type Stop, type TaskSpec, type ToolContext } from "../tools/types";
import { recordVersion, artifactOut } from "../workspace/artifacts";
import { CHECK_LIMIT, projectOverview, projectTasks } from "../workspace/overview";
import { processes } from "../workspace/processes";
import type { Project } from "../workspace/projects";
import { agentLoop, compactable, tokensOf, type LoopEvents } from "./agent";
import { hashFile, planChecks, runCheckList } from "./checks";
import { publish } from "./bus";
import { SoloRun, type SoloHost } from "./solo";
import { SPECIALIST_DEFS, specialistSettings, type Seat } from "./specialists";
import { seatSpecialist } from "./specialistSeats";
import { agentFromRole, departmentColor, departmentsOf, freshName, placeHire, wire } from "./org";
import { tierOf, type Tier } from "./risk";
import { canRunBeside, owns, writes } from "./ownership";
import { Collab, formatPin, type Pin, type Session } from "./collab";
import { acceptanceBrief, instructions, lensOf, LENS, libraryList, outcomeSection, type Verdict, reAcceptanceBrief, reReviewBrief, reviewBrief, revisionNote, skillList, taskBrief } from "./prompts";

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
  /** The changed lines of each task's work since its last review, for a reviewer of a small change. */
  diffs_by_task: Record<string, { text: string; lines: number; files?: string[] }>;
  /** Why a task is running again, for the next turn of its session: review feedback, a user's answer, failed checks. Consumed when the turn starts. */
  resume: Record<string, { from: string; text: string }>;
  /** A task that carries on another task's session (a fix for failed checks continues its author's build). */
  continues: Record<string, string>;
  /** What the user asked for, in their words; the run is accepted against it. */
  requirements: Requirement[];
  /** Pinned posts in the team chat: interfaces and decisions; the latest version of each key is current. */
  pins: Pin[];
  /** The review tasks of each part's current round, by work task id: the round closes when all have finished. */
  rounds: Record<string, string[]>;
  /** Each critic's verdict, by review task id. */
  verdicts: Record<string, Verdict>;
  always: string[];
  verify_rounds: number;
  acceptance_rounds: number;
  /** Review comments left open when a task hit the revision limit, by task id. */
  open_comments: Record<string, string>;
  /** Review findings of each part, with the writer's answers. */
  findings: Record<string, Finding[]>;
  /** How often a part was sent back to answer its open findings before it could finish. */
  gate_tries: Record<string, number>;
  /** Index of the first task of the current request; earlier tasks belong to earlier requests. */
  cycle_from: number;
  /** Index of the first requirement recorded for the current request. */
  req_from: number;
  /** Files changed since the last acceptance check was queued. */
  unaccepted: boolean;
  /** Files changed since the project's checks last ran. */
  unchecked: boolean;
  workflow: WorkflowState;
  verification: { name: string; command: string; ok: boolean; output: string }[];
}
interface Inbound { content: string; display: string; to_agent_id: string | null; images: Item[] }
type Budget = typeof DEFAULT_BUDGET;
/**
 * Steps per turn. Owners get room to build, look and fix in one go; context stays bounded by summarizing, not by
 * cutting the work off. The limit is a backstop against a runaway turn.
 */
const STEPS: Partial<Record<Mode, number>> = { worker: 150, reviewer: 60, acceptance: 60, quick_review: 3 };
/**
 * How much reasoning each kind of turn is worth. Planning and building get depth; a verdict on a diff, a one-paragraph
 * report and a teammate's factual answer do not. An agent or the conversation budget can still override this.
 */
const EFFORT: Record<Mode, Effort> = { orchestrator: "high", worker: "high", acceptance: "medium", reviewer: "medium", quick_review: "low", report: "low", chat: "low", consult: "low" };
/** Documents from finished dependencies up to this size go inside the brief instead of being read with tools. */
const DOCS_IN_BRIEF = 20_000;
/** Longest message between agents; longer material goes in a file and the message names it. */
const MESSAGE_CHARS = 2000;
/** How long an agent waits for a teammate's reply before carrying on. */
const REPLY_WAIT_MS = 10 * 60_000;
/** Steps an idle agent gets to answer a message, and the session size worth loading to answer it. */
const ANSWER_STEPS = 2;
const ANSWER_MAX_CHARS = 80_000;
/** Where a dev server says it listens. */
const LOCAL_URL = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?[^\s"'<>]*/;

class Halt extends Error {}
/** A change this small is reviewed from its diff in one step, instead of by reading files. */
const SMALL_CHANGE = { files: 2, lines: 80, chars: 12000 };
/** The run's report with one more part: the request as its heading, then the reply. Both the pipeline and the solo path write it. */
const appendRecap = (report: string, request: string, text: string) => `${report ? `${report}\n\n---\n\n` : ""}## ${firstLine(request, 100)}\n\n${text}`;
const live = new Map<string, Conversation>();
const PHASES = [["plan", "Plan"], ["build", "Build"], ["review", "Review"], ["verify", "Verify"], ["report", "Report"]] as const;

function emptyUsage(): Usage {
  return { tokens: 0, cost_usd: 0, turns: 0,
    active_seconds: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, reasoning_dropped: 0, llm_calls: 0, per_agent: {}, per_agent_cost: {},
    cost_breakdown: { input: 0, cached_input: 0, output: 0 },
    model_ms: 0, tool_calls: 0, tool_failures: 0, file_reads: 0, redundant_reads: 0, file_writes: 0, files_changed: 0, searches: 0, listings: 0, verifications: 0, agent_runs: 0 };
}

function initialState(): RunState {
  return { agent_status: {}, activity: {}, usage: emptyUsage(), history: [], questions: [], answers: {}, feedback: {}, revisions: {}, files_by_task: {}, diffs_by_task: {},
    resume: {}, continues: {}, requirements: [], pins: [], rounds: {}, verdicts: {},
    always: [], verify_rounds: 0, acceptance_rounds: 0, open_comments: {}, findings: {}, gate_tries: {}, cycle_from: 0, req_from: 0, unchecked: false, unaccepted: false, verification: [], workflow: { track: null, index: 0, ended: false, phases: PHASES.map(([key, title]) => ({ key, title, owner: null, status: "pending" })) } };
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
  /** Live agent sessions (kept in memory; after a restart the next turn starts from a brief), keyed by agent and deliverable. */
  private sessions = new Map<string, Session>();
  private readonly collab: Collab;
  /** This conversation started the project's dev server; it stays up for you after a report and stops when you stop or delete the conversation. */
  private startedServer = false;
  /** Resolved when a user message arrives while tasks run. */
  private wake: ReturnType<typeof deferred<void>> | null = null;
  /** Check commands that already passed for exactly the files the team last changed, so they are not run twice. */
  private checksPassed = new Set<string>();
  /** The solo path, created when this conversation's company is the solo template. */
  private soloRun: SoloRun | null = null;

  private constructor(readonly p: Project, readonly reg: Registry, row: RunRow) {
    this.row = row;
    this.budget = { ...DEFAULT_BUDGET, ...row.budget } as Budget;
    const saved = row.state as Partial<RunState>;
    this.state = { ...initialState(), ...saved };
    // Conversations saved before requests were tracked separately: count what is already there as earlier requests.
    if (saved.cycle_from === undefined && TERMINAL_STATUSES.includes(row.status)) this.state.cycle_from = p.db.tasks.count("run_id = ?", [row.id]);
    this.tasks = p.db.tasks.find("run_id = ?", [row.id], "rowid");
    for (const t of this.tasks) if (t.status === "in_progress") t.status = "todo";
    this.loadTeam();
    this.collab = new Collab({ sessions: this.sessions, name: (id) => this.team.find((a) => a.id === id)?.name ?? "a teammate",
      pins: () => this.state.pins, savePins: (pins) => { this.state.pins = pins; this.save(); } });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────────

  static get(p: Project, reg: Registry, runId: string): Conversation {
    const hit = live.get(runId);
    if (hit && hit.p === p) return hit;
    const row = p.db.runs.get(runId);
    if (!row) throw new UserError("Conversation not found", 404);
    const c = new Conversation(p, reg, row);
    c.closeOrphanedApprovals();
    live.set(runId, c);
    return c;
  }

  static isLive(runId: string) { return live.get(runId)?.turning ?? false; }
  static liveCount() { return [...live.values()].filter((c) => c.turning).length; }

  static create(p: Project, reg: Registry, body: RunCreate): Conversation {
    if (!connection(reg)) throw new UserError("Connect Azure OpenAI first: Settings → Model.", 412);
    const company = p.db.companies.get(body.company_id);
    if (!company) throw new UserError("Team not found", 404);
    const budget = { ...DEFAULT_BUDGET, ...(body.budget ?? {}) };
    const sessionId = body.session_id ?? newId();
    if (!body.session_id) p.db.sessions.insert({ id: sessionId, company_id: company.id, agent_id: null, mode: "company", title: firstLine(body.goal, 80), created_at: now() });
    const row: RunRow = {
      id: newId(), company_id: company.id, session_id: sessionId, goal: body.goal, title: "", status: "queued", mode: body.mode ?? "autonomous", budget,
      permission_level: reg.setting("approval_mode", "ask"), summary: "", halt_reason: "", report_md: "", tokens_used: 0, cost_usd: 0, turns: 0,
      outcome: null, snapshot: { agents: [], edges: [], departments: company.departments }, state: initialState() as never,
      created_at: now(), started_at: null, ended_at: null,
    };
    p.db.runs.insert(row);
    const c = new Conversation(p, reg, row);
    live.set(row.id, c);
    if (c.lead.behavior.template_key === MAIN_ROLE) c.seatEnabled();
    c.submit(body.goal, body.attachments ?? [], null);
    conversationName(reg, body.goal).then((name) => { if (name) c.setName(name); }).catch(() => undefined);
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

  /** Whether a turn is running now, in either path. */
  get turning(): boolean { return this.driving || !!this.soloRun?.running; }

  /** The solo path, or null: a conversation whose company is the solo template runs through it. */
  private get solo(): SoloRun | null {
    if (this.lead.behavior.template_key !== MAIN_ROLE) return null;
    this.soloRun ??= new SoloRun(this.soloHost());
    return this.soloRun;
  }

  private soloHost(): SoloHost {
    return {
      p: this.p, reg: this.reg, runId: this.row.id, state: this.state, lead: () => this.lead, signal: () => this.abort.signal,
      requirements: () => this.state.requirements, setRequirements: (list) => this.setRequirements(list),
      emit: (type, data) => this.emit(type, data),
      post: (m) => this.post({ from: this.lead.id, to: null, ...m }),
      recap: (title, text) => { this.row.report_md = appendRecap(this.row.report_md, title, text); },
      setRunStatus: (status, extra) => this.setRunStatus(status, extra),
      setStatus: (agent, status, activity) => this.setStatus(agent, status, activity),
      loopEvents: (agent) => this.loopEvents(agent),
      toolContext: (agent, memory) => this.context(agent, null, undefined, memory),
      seat: (name) => this.seat(name),
      notes: () => [...this.p.db.memory.find("agent_id = ?", [SHARED_MEMORY]), ...this.p.db.memory.find("agent_id = ?", [this.lead.id])],
      model: (agent) => this.model(agent),
      effort: (agent) => this.effort(agent, "worker"),
      finish: (reason, status) => this.finishHalted(reason, status),
    };
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
    // A message sent from one agent's chat answers a pending question only when that agent asked it.
    const asked = this.state.questions[0];
    const pending = toAgentId && asked && toAgentId !== asked.question.agent_id ? undefined : asked;
    const msg = this.post({ from: null, to: pending?.question.agent_id ?? target, sender: "user", type: pending ? "answer" : "task", content: content + files,
      meta: { display_content: content, images: images.map((i) => i.name), attachments: attachments.map((a) => a.filename) } });
    if (this.row.status !== "queued" && TERMINAL_STATUSES.includes(this.row.status)) this.emit("run_continued", { content: firstLine(content, 200) });
    if (this.solo) {
      this.solo.submit(content + files, images.map((i) => ({ type: "input_image", image_url: i.url })));
      return msg.id;
    }
    // A message to a teammate who is working goes into its own chat before its next step, not into a new plan.
    const mate = !pending && target && target !== this.lead.id && this.driving ? this.team.find((a) => a.id === target) : undefined;
    if (mate && this.busy.has(mate.id)) {
      this.collab.deliver(mate.id, `Message ${msg.id} from the user:\n${content}${files}\n\nTake it into account in your work, and answer with reply (message_id "${msg.id}") at a good point.`);
      return msg.id;
    }
    this.queue.push({ content: content + files, display: content, to_agent_id: pending ? null : target, images: images.map((i) => ({ type: "input_image", image_url: i.url })) });
    this.wake?.resolve();
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
    if (!this.driving && !this.solo) void this.drive();
  }

  resolveApproval(id: string, approved: boolean, scope: "once" | "always", reason = "") {
    const a = this.approvals.get(id);
    if (!a) throw new UserError("That approval is no longer pending", 409);
    if (approved && scope === "always" && a.req.details.key) this.state.always.push(a.req.details.key);
    a.done(approved, reason);
  }

  /**
   * Approvals wait in memory. A request stored by a process that has since stopped can never be answered, so the run
   * view would keep offering it. Close each such request in the log. Called once, when the run loads into a process.
   */
  private closeOrphanedApprovals() {
    const open = new Map<string, PendingApproval>();
    for (const e of this.p.db.events.find("run_id = ? AND type IN ('approval_requested', 'approval_resolved')", [this.row.id], "seq")) {
      const d = e.data as PendingApproval;
      if (e.type === "approval_requested") open.set(d.id, d);
      else open.delete(d.id);
    }
    for (const a of open.values())
      this.emit("approval_resolved", { id: a.id, approved: false, reason: "The app restarted before this was answered.", agent_id: a.agent_id, kind: a.kind, summary: a.summary });
  }

  snapshot(): RunEventMap["snapshot"] {
    return { status: this.row.status, live: this.turning, agent_status: this.state.agent_status, activity: this.state.activity,
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

  private newTask(spec: Omit<TaskOut, "id" | "run_id" | "key" | "status" | "result" | "attempts" | "updated_at" | "requirements" | "files" | "skills" | "specialists">
    & Partial<Pick<TaskOut, "requirements" | "files" | "skills" | "specialists">>): TaskOut {
    const t: TaskOut = { requirements: [], files: [], skills: [], specialists: [], ...spec, id: newId(), run_id: this.row.id, key: `T${this.tasks.length + 1}`, status: "todo", result: "", attempts: 0, updated_at: now() };
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
      toolResult: (call_id, tool, ok, output, metrics) => {
        const u = this.state.usage;
        u.tool_calls++;
        if (!ok) u.tool_failures++;
        if (metrics?.read) u.file_reads++;
        if (metrics?.redundant) u.redundant_reads++;
        if (metrics?.wrote) u.file_writes++;
        if (metrics?.searched) u.searches++;
        if (metrics?.listed) u.listings++;
        this.emit("tool_result", { call_id, agent_id: agent.id, tool, ok, output: clip(output, 4000) });
      },
      usage: (r) => {
        const u = this.state.usage;
        const parts = costParts(r.usage, connection(this.reg)?.options);
        u.turns++; u.llm_calls++;
        u.model_ms += r.ms ?? 0;
        u.input_tokens += r.usage.input; u.cached_tokens += r.usage.cached; u.output_tokens += r.usage.output; u.reasoning_tokens += r.usage.reasoning; u.reasoning_dropped += r.reasoningDropped;
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
        this.setStatus(agent, "thinking", "Thinking");
      },
    };
  }

  private context(agent: AgentOut, task: TaskOut | null, planner?: ToolContext["planner"], memory: Pick<Session, "seen" | "shown"> = { seen: new Map(), shown: new Map() }): ToolContext {
    return {
      agent, task, runId: this.row.id, fs: this.p.fs, db: this.p.db, reg: this.reg, signal: this.abort.signal, planner,
      team: () => this.team, seen: memory.seen, shown: memory.shown,
      guard: (req) => this.guard(agent, req),
      emit: (type, data) => this.emit(type, data),
      setStatus: (status, activity) => this.setStatus(agent, status, activity),
      recordFile: (rel, before, after, note) => {
        const { row, lines, previous_lines } = recordVersion(this.p.db, { runId: this.row.id, path: rel, before, after, author: agent.id, note });
        if (task) this.state.files_by_task[task.id] = [...new Set([...(this.state.files_by_task[task.id] ?? []), rel])];
        this.state.usage.files_changed = new Set(Object.values(this.state.files_by_task).flat()).size;
        if (task) this.recordDiff(task.id, rel, before, after);
        this.state.unchecked = true;
        this.state.unaccepted = true;
        this.collab.fileChanged(agent.id, rel, after === null ? "deleted" : before === null ? `new file, ${lines} lines` : `${previous_lines} → ${lines} lines`);
        this.emit("artifact_updated", { artifact: { ...artifactOut(row), created: before === null, lines, previous_lines } });
      },
      message: (to, text, wait) => this.message(agent, to, text, wait),
      reply: (id, text) => this.reply(agent, id, text),
      pin: (key, text, paths) => this.pin(agent, key, text, paths),
      answering: null,
      ownerOf: (rel) => {
        const t = this.tasks.find((x) => x.status === "in_progress" && x.id !== task?.id && writes(x) && x.files.length && owns(x.files, rel));
        return t ? `${t.key} (${this.team.find((a) => a.id === t.assignee_agent_id)?.name ?? "a teammate"})` : null;
      },
      devServer: () => this.devServer(),
    };
  }

  /** The project's dev server, started in the background when it is not running, and the URL it printed. */
  /**
   * A file a live session holds may have changed on disk since the session read it (the user edited it, or a program
   * wrote it). Dropping the stale entry keeps both the rename guard and the unchanged-read shortcut truthful.
   */
  private refreshFileState() {
    for (const s of this.sessions.values()) {
      for (const [rel, hash] of s.seen) if (hashFile(this.p.fs, rel) !== hash) { s.seen.delete(rel); s.shown.delete(rel); }
    }
  }

  private async devServer(): Promise<{ command: string; url: string | null; output: string }> {
    const server = processes(this.p.id).server;
    if (server.status !== "running") {
      // Only the conventional dev scripts: anything else named like a server (deploy, release) is not ours to start.
      const scripts = projectTasks(this.p.fs).filter((t) => t.kind === "server");
      const pick = ["dev", "start", "serve", "preview"].map((n) => scripts.find((t) => t.id.endsWith(`:${n}`))).find(Boolean);
      if (!pick) throw new UserError("The project has no dev server script (dev, start, serve or preview in package.json). Add one first.");
      server.start(this.p.fs, pick.command, pick.directory);
      this.startedServer = true;
    }
    const url = () => LOCAL_URL.exec(server.view().output.replace(/\x1b\[[0-9;]*m/g, ""))?.[0].replace("0.0.0.0", "localhost") ?? null;
    for (let i = 0; i < 120 && !url() && server.status === "running" && !this.stopped; i++) await sleep(250);
    return { command: server.command, url: url(), output: server.view().output };
  }

  private model(agent: AgentOut) { return this.budget.model || agent.model || config.defaultModel; }
  private effort(agent: AgentOut, mode: Mode) {
    if (this.budget.reasoning_effort !== "default") return this.budget.reasoning_effort;
    const own = agent.behavior.reasoning_effort;
    return own && own !== "default" ? own : EFFORT[mode] ?? config.defaultEffort;
  }

  /**
   * A live session that can take another turn, or undefined. A session the next call could not carry is dropped, so the
   * next turn starts from a brief.
   */
  private liveSession(key: string): Session | undefined {
    const s = this.sessions.get(key);
    if (s && this.oversized(s)) { this.sessions.delete(key); return undefined; }
    return s;
  }

  /**
   * Over the context window with nothing a checkpoint could replace. Compaction runs before every call, so a session
   * it can still shrink is kept, and only one it cannot shrink is dropped.
   */
  private oversized(s: Session): boolean {
    const window = contextWindow(this.reg);
    return tokensOf(s.input) > window && !compactable(s.input, s.head, window);
  }

  /**
   * One agent turn. With `session`, the turn continues that session's transcript, instructions and tools, so the agent
   * keeps what it already read and the model's cached prefix stays valid; without one it starts fresh.
   */
  private async turn(agent: AgentOut, mode: Mode, task: TaskOut | null, input: Item[], opts: { planner?: ToolContext["planner"]; maxRounds: number; session?: string; preload?: { path: string; content: string }[]; answering?: string }) {
    let s = opts.session ? this.liveSession(opts.session) : undefined;
    if (!s) {
      // Registered before anything is awaited, so a message or amend_task sent meanwhile lands in its inbox.
      s = { agentId: agent.id, mode, instructions: "", tools: [], input: [], seen: new Map(), shown: new Map(), files: task?.files ?? [], inbox: this.collab.takeHeld(agent.id), head: 0, used: 0 };
      if (opts.session) this.sessions.set(opts.session, s);
      try {
        const { tools, warnings } = await toolbox(this.reg, this.p.root, agent, mode);
        for (const w of warnings) this.emit("error", { message: w, kind: "warning", agent_id: agent.id });
        const company = this.p.db.companies.get(this.row.company_id);
        s.tools = tools;
        s.instructions = instructions({
          agent, company: company?.name ?? "the company", goal: this.row.goal, team: this.team, overview: projectOverview(this.p.fs), skills: skillsFor(this.reg, agent, task?.skills),
          memory: { own: this.p.db.memory.find("agent_id = ?", [agent.id]), shared: this.p.db.memory.find("agent_id = ?", [SHARED_MEMORY]) },
          wanted: task?.skills,
        }, mode);
      } catch (e) {
        if (opts.session) this.sessions.delete(opts.session);
        throw e;
      }
      // Documents put in the brief count as read, so the agent is not sent them twice.
      // The brief is the first item of the transcript, so a document in it is at position 0 and is never summarized away.
      for (const d of opts.preload ?? []) { const hash = sha1(d.content); s.seen.set(d.path, hash); s.shown.set(d.path, { hash, ranges: [[1, d.content.split("\n").length]], at: 0 }); }
    }
    // What arrived while the session was idle comes first, so the new instruction is the last thing the agent reads.
    if (s.inbox.length) s.input.push({ role: "user", content: s.inbox.splice(0).join("\n\n") });
    s.input.push(...input);
    if (!s.head) s.head = s.input.length; // the first brief, and what arrived with it, survive summarizing
    s.used = ++this.turnCount;
    this.state.usage.agent_runs++;
    this.emit("turn_started", { agent_id: agent.id, task_key: task?.key });
    try {
      return await agentLoop({ reg: this.reg, model: this.model(agent), effort: this.effort(agent, s.mode), instructions: s.instructions, input: s.input, tools: s.tools, inbox: s.inbox,
        ctx: { ...this.context(agent, task, opts.planner, s), answering: opts.answering ?? null }, events: this.loopEvents(agent), maxRounds: opts.maxRounds, keepHead: s.head,
        requireStop: s.mode !== "consult" && s.mode !== "report" && !opts.answering, stopTools: endingNames(s.tools), cacheKey: `${this.row.id}:${agent.id}:${s.mode}` });
    } catch (e) {
      if (opts.session) this.sessions.delete(opts.session); // its transcript may end mid-round
      throw e;
    } finally {
      this.setStatus(agent, "idle");
    }
  }

  // ── talking while working ──────────────────────────────────────────────────────────────────────────────────────

  /** One agent messages another, or the team chat. See the `message` tool. */
  private async message(from: AgentOut, toName: string, text: string, wait: boolean): Promise<string> {
    const body = clip(text.trim(), MESSAGE_CHARS);
    if (/^(team|everyone|all)$/i.test(toName.trim())) {
      this.post({ from: from.id, to: null, type: "chat", content: body });
      const mentioned = this.team.filter((a) => a.id !== from.id && body.toLowerCase().includes(`@${a.name.toLowerCase()}`));
      for (const a of mentioned) this.collab.deliver(a.id, `${from.name} mentioned you in the team chat:\n${body}`);
      return mentioned.length ? `Posted to the team chat; ${mentioned.map((a) => a.name).join(", ")} will see it.` : "Posted to the team chat.";
    }
    const to = this.findAgent(toName);
    if (!to) return `No teammate called ${toName}. Team: ${this.team.map((a) => `${a.name} (${a.role})`).join(", ")}, or "team".`;
    if (to.id === from.id) return "That is you.";
    const msg = this.post({ from: from.id, to: to.id, type: "question", content: body });
    const working = this.busy.has(to.id);
    const blocking = wait && !this.collab.wouldDeadlock(from.id, to.id);
    const reply = this.collab.awaitReply(msg.id, from.id, to.id, this.abort.signal, REPLY_WAIT_MS, blocking);
    if (working) {
      // They answer from inside the work they are doing, at their next step.
      this.collab.deliver(to.id, `Message ${msg.id} from ${from.name}:\n${body}\n\nAnswer with reply (message_id "${msg.id}")${blocking ? "; they are waiting for it" : " when you reach a good point"}.`);
    } else {
      // Idle: answer now, from the session that still holds what they know.
      this.answerTurn(to, { from: `${from.name} (${from.role})`, askerId: from.id, messageId: msg.id, body });
    }
    if (blocking) return `${to.name} replied: ${await reply}`;
    void reply.then((t) => { if (!this.stopped) this.collab.deliver(from.id, `${to.name} replied to your message ${msg.id}:\n${t}`); });
    if (wait) return `Sent. Not waiting: ${to.name} is waiting for you, so waiting would deadlock. Their reply will reach you.`;
    return `Sent to ${to.name}. The reply will reach you before a later step.`;
  }

  /** Answer turns in flight; the run waits for them before it decides that nothing more can start. */
  private answering = new Set<Promise<void>>();
  /** Turns started so far, to tell which of an agent's sessions it used last. */
  private turnCount = 0;

  /**
   * An idle agent answers, continuing its latest session so it answers with what it already knows: one message, or
   * (with no messageId) the messages that reached it after its last step. A plain-text answer is posted as a reply.
   */
  private answerTurn(to: AgentOut, q: { from: string; askerId: string | null; messageId: string | null; body: string }) {
    this.busy.add(to.id);
    const run = (async () => {
      try {
        const latest = this.collab.latestSession(to.id);
        // A teammate's session holds what it knows, but a huge one costs more than the question is worth.
        const live = latest && JSON.stringify(latest.session.input).length <= ANSWER_MAX_CHARS ? latest : undefined;
        const prompt = q.messageId
          ? `Message ${q.messageId} from ${q.from}:\n${q.body}\n\nAnswer from what you already know; read files only if you must, and change nothing. Answer with reply (message_id "${q.messageId}"), or in plain text.`
          : `These messages reached you after your last step:\n\n${q.body}\n\nAnswer each with reply, from what you already know; change nothing.`;
        const answering = q.messageId ?? undefined;
        const res = live
          ? await this.turn(to, live.session.mode, null, [{ role: "user", content: prompt }], { session: live.key, maxRounds: ANSWER_STEPS, answering })
          : await this.turn(to, "consult", null, [{ role: "user", content: prompt }], { maxRounds: ANSWER_STEPS, answering });
        const text = res.stop?.kind === "answered" ? "" : res.text.trim();
        if (text) {
          this.post({ from: to.id, to: q.askerId, type: "answer", content: clip(text, MESSAGE_CHARS), meta: q.messageId ? { reply_to: q.messageId } : {} });
          if (q.messageId) this.collab.answer(q.messageId, text);
        } else if (q.messageId) this.collab.answer(q.messageId, `(${to.name} gave no answer)`);
      } catch (e) {
        if (q.messageId) this.collab.answer(q.messageId, `(${to.name} could not answer: ${(e as Error).message})`);
      } finally {
        this.busy.delete(to.id);
        this.settleUnread(to);
        this.wake?.resolve(); // a task for this agent may have been held back while it answered
      }
    })();
    this.answering.add(run);
    void run.finally(() => this.answering.delete(run));
  }

  /**
   * After an agent's turn: messages that reached its session after its last step are answered now, so none is lost;
   * with none left, anyone still waiting on it is released.
   */
  private settleUnread(agent: AgentOut | undefined) {
    if (!agent || this.busy.has(agent.id) || this.stopped) return;
    const live = this.collab.latestSession(agent.id);
    const inbox = live?.session.inbox ?? [];
    const unread = inbox.filter((n) => n.startsWith("Message "));
    if (unread.length) {
      inbox.splice(0, inbox.length, ...inbox.filter((n) => !n.startsWith("Message ")));
      this.answerTurn(agent, { from: "teammates", askerId: null, messageId: null, body: unread.join("\n\n") });
      return;
    }
    this.collab.agentIdle(agent.id);
  }

  /** The user asked one teammate directly: that becomes its task, continuing the work it already has in hand. */
  private directTask(msg: Inbound, agent: AgentOut) {
    const live = this.collab.latestSession(agent.id);
    const prior = live?.session.mode === "worker" ? /^[^:]+:([^:]+)$/.exec(live.key)?.[1] : undefined; // worker sessions are keyed agent:task
    const t = this.newTask({ title: firstLine(msg.display, 80), description: msg.content, acceptance_criteria: "Do what the user asked; verify it.", assignee_agent_id: agent.id,
      kind: canWrite(agent) ? "build" : "research", depends_on: [], created_by: null, files: this.tasks.find((x) => x.id === prior)?.files ?? [] });
    if (prior) this.state.continues[t.id] = prior;
  }

  private reply(from: AgentOut, messageId: string, text: string): string {
    const original = this.p.db.messages.get(messageId.trim());
    if (!original || original.run_id !== this.row.id) return `There is no message ${messageId} in this conversation.`;
    const asker = original.from_agent_id;
    this.post({ from: from.id, to: asker, type: "answer", content: clip(text.trim(), MESSAGE_CHARS), meta: { reply_to: original.id } });
    if (this.collab.answer(original.id, text)) return "Sent; they were waiting for it.";
    if (asker) this.collab.deliver(asker, `${from.name} replied to your message ${original.id}:\n${text}`);
    return "Sent.";
  }

  /** The current pinned posts about these paths, formatted for a brief. */
  private pinsFor(paths: string[]): string[] {
    return this.collab.pinsFor(paths).map((p) => formatPin(p, this.team.find((a) => a.id === p.author)?.name ?? "a teammate"));
  }

  private pin(from: AgentOut, key: string, text: string, paths: string[]): string {
    const rels = paths.map((f) => this.p.fs.rel(f) || f);
    const pin = this.collab.pin(from.id, key.trim(), text.trim(), rels, now());
    this.post({ from: from.id, to: null, type: "decision", content: formatPin(pin, from.name), meta: { pin: pin.id, key: pin.key, version: pin.version, paths: rels } });
    return `Pinned "${pin.key}" (v${pin.version}).`;
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
      // A custom title builds on the developer role: its prompt and playbooks, plus the hire's own instructions.
      ...roles.find((r) => r.key === "developer")!, role: spec.title, description: spec.reason, avatar: "bot", color: departmentColor(spec.department),
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

  /** A specialist's seat: its agent, reporting to Octopus, and the two channels between them. The first use adds the agent to the canvas. */
  private seat(name: SpecialistName): Seat {
    const lead = this.lead;
    const made = seatSpecialist(this.p, this.row.company_id, name);
    const { agent, edges } = made;
    if (made.added) {
      this.team.push(agent);
      this.edges.push(...edges);
      this.row.snapshot = { ...this.row.snapshot, agents: this.team, edges: this.edges };
      this.state.agent_status[agent.id] = "idle";
      this.emit("agent_created", { agent, edges, created_by: lead.id, persisted: true, reason: `${SPECIALIST_DEFS[name].title} checks the work for ${lead.name}`, department: { name: agent.department, color: departmentColor(agent.department) } });
      this.save();
    } else if (!this.team.some((a) => a.id === agent.id)) {
      // Seated by another conversation or by the palette since this one loaded: take the company's current team.
      this.team = this.p.db.agents.find("company_id = ?", [this.row.company_id]);
      this.edges = this.p.db.edges.find("company_id = ?", [this.row.company_id]);
      this.row.snapshot = { ...this.row.snapshot, agents: this.team, edges: this.edges };
    }
    const id = agent.id;
    const delegate = this.edges.find((e) => e.type === "delegate" && e.source_agent_id === lead.id && e.target_agent_id === id);
    const report = this.edges.find((e) => e.type === "report" && e.source_agent_id === id && e.target_agent_id === lead.id);
    if (!delegate || !report) throw new Error(`${SPECIALIST_DEFS[name].title} has no channel to ${lead.name}`);
    return { agent, delegate, report };
  }

  /** A solo conversation's canvas shows one card per specialist that Settings turns on, so they are seated before the first turn. */
  /** Sets the name the model wrote for this conversation. Only a row still in the store takes it, so a deleted conversation stays deleted. */
  setName(title: string) {
    this.row.title = title;
    if (this.p.db.runs.get(this.row.id)) this.p.db.runs.upsert(this.row);
  }

  private seatEnabled() {
    const settings = specialistSettings(this.reg);
    for (const name of SPECIALIST_NAMES) if (settings.specialists[name].enabled) this.seat(name);
  }
  /** Keeps the changed lines of a task's files since its last review, so a reviewer of a small change can read the diff. */
  private recordDiff(taskId: string, rel: string, before: string | null, after: string | null) {
    const hunk = changedLines(before, after);
    const prev = this.state.diffs_by_task[taskId] ?? { text: "", lines: 0, files: [] };
    this.state.diffs_by_task[taskId] = { text: clip(`${prev.text}\n\n## ${rel}\n${hunk.text}`.trim(), SMALL_CHANGE.chars), lines: prev.lines + hunk.lines,
      files: [...new Set([...(prev.files ?? []), rel])] };
  }

  /** The task's change since its last review, when it is small enough for a quick review from its diff. */
  private smallChange(work: TaskOut) {
    const diff = this.state.diffs_by_task[work.id];
    const fits = !!diff && diff.lines <= SMALL_CHANGE.lines && (diff.files ?? []).length <= SMALL_CHANGE.files && diff.text.length < SMALL_CHANGE.chars;
    return fits ? diff : null;
  }

  /**
   * How much checking a part's change gets, decided from what it touched. The choice is shown in the run, so a skipped
   * review is visible rather than silent.
   */
  private riskOf(task: TaskOut, agent: AgentOut): Tier {
    const files = this.state.files_by_task[task.id] ?? [];
    const lines = this.state.diffs_by_task[task.id]?.lines ?? 0;
    const requirements = this.cycleRequirements().filter((r) => r.status === "open" || r.status === "unmet").length;
    const revised = (this.state.revisions[this.state.continues[task.id] ?? task.id] ?? 0) > 0;
    const tier = tierOf({ files, lines, specialists: task.specialists.length, requirements, revised });
    const size = `${files.length} file${files.length === 1 ? "" : "s"}, ${lines} changed line${lines === 1 ? "" : "s"}`;
    this.emit("thought", { agent_id: agent.id, text: `${task.key} is a ${tier} change (${size})${tier === "trivial" ? ", so it is not reviewed" : ""}.` });
    return tier;
  }

  /** The documents finished dependencies wrote, when they are small enough to hand over inside the brief. */
  private depDocs(deps: TaskOut[]): { path: string; content: string }[] {
    const docs: { path: string; content: string }[] = [];
    let size = 0;
    for (const d of deps.filter((x) => x.kind === "docs" && x.status === "done")) {
      for (const rel of this.state.files_by_task[d.id] ?? []) {
        let content: string;
        try { content = readFileSync(this.p.fs.abs(rel), "utf8"); } catch { continue; }
        if (size + content.length > DOCS_IN_BRIEF) return docs;
        size += content.length;
        docs.push({ path: rel, content });
      }
    }
    return docs;
  }

  /** Who reviews a piece of work: a review channel to the author, their department lead, a reviewer on the team, or a new tech lead. */
  private reviewerFor(author: AgentOut): AgentOut {
    const byChannel = this.edges.find((e) => e.type === "review" && e.target_agent_id === author.id && e.source_agent_id !== author.id);
    const assigned = byChannel && this.team.find((a) => a.id === byChannel.source_agent_id && canReview(a));
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
        if (msg && pending && !msg.to_agent_id) {
          this.state.questions.shift();
          if (pending.task_id) {
            this.state.answers[pending.task_id] = msg.content;
            this.state.resume[pending.task_id] = { from: "The user's answer to your question", text: msg.content };
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
          this.refreshFileState();
          const direct = msg.to_agent_id && msg.to_agent_id !== this.lead.id ? this.team.find((a) => a.id === msg.to_agent_id) : undefined;
          if (direct) this.directTask(msg, direct);
          else if ((await this.plan(msg)) !== "work") continue;
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
        else this.setRunStatus(this.cycleStatus(this.tasks.slice(this.state.cycle_from)), { reason: "" });
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
    if (this.startedServer) processes(this.p.id).server.stop();
    for (const a of this.approvals.values()) a.done(false, "The conversation was stopped");
    this.gate?.resolve();
    this.gate = null;
    if (this.solo) return this.solo.stop(reason, status);
    if (!this.driving) this.finishHalted(reason, status);
    else this.pendingHalt = { reason, status };
  }
  private pendingHalt: { reason: string; status: RunStatus } | null = null;

  private finishHalted(reason: string, status: RunStatus = "incomplete") {
    const h = this.pendingHalt ?? { reason, status };
    this.pendingHalt = null;
    for (const t of this.tasks) if (t.status === "in_progress") this.saveTask({ ...t, status: "todo" });
    this.sessions.clear(); // a stopped turn can leave a transcript mid-round
    for (const a of this.team) this.setStatus(a, "idle");
    this.setRunStatus(h.status, { reason: h.reason, summary: h.status === "cancelled" ? "Stopped. Send a message to continue." : `${h.reason}. Send a message to continue.` });
  }

  private orchestratorInput(msg: Inbound, note = ""): Item[] {
    const history = this.state.history.slice(0, -1).slice(-12).map((h) => `**${h.role === "user" ? "User" : "You"}:** ${clip(h.content, 3000)}`).join("\n\n");
    const open = this.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const done = this.tasks.filter((t) => t.status === "done").slice(-15);
    const who = (id: string | null) => this.team.find((a) => a.id === id)?.name ?? "?";
    const reqs = (t: TaskOut) => (t.requirements.length ? ` [${t.requirements.join(", ")}]` : "");
    const context = [
      history && `## Conversation so far\n${history}`,
      this.state.requirements.length && `## Requirements\n${this.state.requirements.map((r) => `- ${r.id} [${r.status}] ${r.text}${r.note ? ` (${r.note})` : ""}`).join("\n")}`,
      done.length && `## Finished tasks\n${done.map((t) => `- ${t.key} ${t.title} (${who(t.assignee_agent_id)})${reqs(t)}: ${firstLine(t.result, 200)}`).join("\n")}`,
      open.length && `## Open tasks\n${open.map((t) => `- ${t.key} [${t.status}] ${t.title} (${who(t.assignee_agent_id)})${reqs(t)}${t.result ? `: ${firstLine(t.result, 200)}` : ""}`).join("\n")}`,
      `## Role library (for hire_agent)\n${libraryList(effectiveRoles(this.reg))}`,
      `## Skills (for create_task skills)\n${skillList(effectiveSkills(this.reg))}`,
      `## Limits\nTeam: ${this.team.length} of at most ${this.budget.max_agents} people. Tasks run ${this.budget.max_concurrency} at a time.`,
      note,
    ].filter(Boolean).join("\n\n");
    return [
      { role: "developer", content: context },
      { role: "user", content: msg.images.length ? [{ type: "input_text", text: msg.content }, ...msg.images] : msg.content },
    ];
  }

  private setRequirements(list: Requirement[]) {
    this.state.requirements = list;
    this.emit("requirements_updated", { requirements: list });
    this.save();
  }

  /**
   * The requirements the current request is about: the ones it recorded, earlier ones its tasks took on, and earlier
   * ones that were never checked, which are still owed.
   */
  private cycleRequirements(): Requirement[] {
    const owned = new Set(this.tasks.slice(this.state.cycle_from).flatMap((t) => t.requirements));
    return this.state.requirements.filter((r, i) => i >= this.state.req_from || owned.has(r.id) || r.status === "open");
  }

  /** The orchestrator's planning turn. Returns what happened. */
  private async plan(msg: Inbound, midRun = false): Promise<"work" | "replied" | "asked"> {
    // The lead keeps one session for the whole conversation: the project it read and the decisions it made stay in
    // context instead of being rebuilt from a digest on every message.
    const note = midRun ? "The team is already working on the open tasks above. If the message changes or adds to work in progress, add requirements and use amend_task on the task that owns it; create a task only for new work. If it needs no change, answer with reply_to_user." : "";
    const lead = this.lead;
    this.phase("plan", "active", lead.id);
    const before = this.tasks.length;
    const requirement = (id: string) => {
      const r = this.state.requirements.find((x) => x.id === id.trim().toUpperCase());
      if (!r) throw new UserError(`There is no requirement ${id}. Requirements: ${this.state.requirements.map((x) => x.id).join(", ") || "none yet (use set_requirements)"}.`);
      return r;
    };
    const planner: Planner = {
      hire: (spec: HireSpec) => this.hire(spec, lead),
      tasks: () => this.tasks,
      requirements: () => this.cycleRequirements(),
      addRequirements: (texts) => {
        const items = texts.map((t) => t.trim().replace(/^["“”']+|["“”']+$/g, "").trim()).filter(Boolean);
        // A fragment ("EXIT") cannot be checked on its own; it belongs inside the ask it came from.
        const fragments = items.filter((t) => t.split(/\s+/).length < 2);
        if (fragments.length) throw new UserError(`These are fragments, not whole asks: ${fragments.map((f) => `"${f}"`).join(", ")}. Keep each ask whole, including any quoted words in it, and call set_requirements again.`);
        const known = new Set(this.state.requirements.map((r) => r.text.toLowerCase()));
        const fresh = items.filter((t) => !known.has(t.toLowerCase()) && (known.add(t.toLowerCase()), true));
        const start = this.state.requirements.length;
        const added = fresh.map((text, i): Requirement => ({ id: `R${start + i + 1}`, text, status: "open", note: "" }));
        this.setRequirements([...this.state.requirements, ...added]);
        return added;
      },
      cutRequirement: (id, reason) => {
        const r = { ...requirement(id), status: "cut" as const, note: reason.trim() };
        this.setRequirements(this.state.requirements.map((x) => (x.id === r.id ? r : x)));
        return r;
      },
      addTask: (spec: TaskSpec) => {
        const assignee = this.findAgent(spec.assignee);
        if (!assignee) throw new UserError(`Nobody called ${spec.assignee}. Hire them first or pick someone on the team.`);
        if (assignee.id === lead.id) throw new UserError("Assign the work to a specialist; you lead and review.");
        const deps = spec.depends_on.filter((k) => this.tasks.some((t) => t.key === k));
        const requirements = spec.requirements.map((id) => requirement(id).id);
        const known = new Set(effectiveSkills(this.reg).map((s) => s.name));
        const unknown = spec.skills.filter((s) => !known.has(s));
        if (unknown.length) throw new UserError(`Unknown skills: ${unknown.join(", ")}. Pick from the skill list.`);
        const files = spec.files.map((f) => this.p.fs.rel(f) || f);
        const specialistAgents = spec.specialists.map((name) => {
          const a = this.findAgent(name);
          if (!a) throw new UserError(`Nobody called ${name} to review this. Hire them first or pick someone on the team.`);
          return a;
        });
        const staffing = staffingError(assignee, specialistAgents);
        if (staffing) throw new UserError(staffing);
        const specialists = specialistAgents.map((a) => a.id);
        const t = this.newTask({ title: spec.title, description: spec.description, acceptance_criteria: spec.acceptance_criteria, assignee_agent_id: assignee.id,
          kind: spec.kind, depends_on: deps, created_by: lead.id, requirements, files, skills: spec.skills, specialists });
        this.post({ from: lead.id, to: assignee.id, type: "task", content: `**${t.title}**\n\n${t.description}`, meta: { task_id: t.key } });
        return t;
      },
      amendTask: (key, note) => {
        const t = this.tasks.find((x) => x.key === key.trim().toUpperCase());
        if (!t || !["todo", "in_progress", "waiting"].includes(t.status)) throw new UserError(`${key} is not open. Create a task for new work instead.`);
        this.saveTask({ ...t, description: `${t.description}\n\n## Update from ${lead.name}\n${note}` });
        // A session that will take another turn gets the update before its next step; a fresh brief includes the description.
        this.sessions.get(`${t.assignee_agent_id}:${this.state.continues[t.id] ?? t.id}`)?.inbox.push(`## Update from ${lead.name} on ${t.key}\n${note}`);
        this.post({ from: lead.id, to: t.assignee_agent_id, type: "task", content: `**Update to ${t.key}**\n\n${note}`, meta: { task_id: t.key } });
        return t;
      },
    };
    const res = await this.turn(lead, "orchestrator", null, this.orchestratorInput(msg, note), { planner, maxRounds: 30, session: `${lead.id}:lead` });
    const stop = res.stop;
    // The turn ended because a tool kept failing: say so plainly instead of reporting work that was never planned.
    if (stop?.kind === "block") {
      const text = `I could not plan this request: ${stop.reason}`;
      this.phase("plan", "failed", lead.id, firstLine(stop.reason, 120));
      if (midRun) this.post({ from: lead.id, to: null, type: "answer", content: text });
      else this.finishCycle(text, "incomplete");
      return "replied";
    }
    if (stop?.kind === "ask") {
      this.state.questions.push({ question: { agent_id: lead.id, question: stop.question, options: stop.options, allow_other: true }, task_id: null });
      if (this.state.questions.length === 1) this.askNext();
      this.phase("plan", "active", lead.id, "Waiting for your answer");
      if (!midRun) this.setRunStatus("awaiting_user", { reason: "Waiting for your answer" });
      return "asked";
    }
    if (stop?.kind === "plan_ready" || (this.tasks.length > before && stop?.kind !== "reply")) {
      const cuts = this.state.requirements.filter((r) => r.status === "cut");
      const note2 = [stop?.kind === "plan_ready" ? stop.note : res.text, cuts.length && `**Not included:**\n${cuts.map((r) => `- ${r.id} ${r.text}: ${r.note}`).join("\n")}`].filter(Boolean).join("\n\n");
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
        const direct = msg.to_agent_id && msg.to_agent_id !== this.lead.id ? this.team.find((a) => a.id === msg.to_agent_id) : undefined;
        if (direct) this.directTask(msg, direct);
        else await this.plan(msg, true);
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
        if (!canRunBeside(t, this.tasks.filter((x) => running.has(x.id)))) continue;
        worked = true;
        this.busy.add(t.assignee_agent_id ?? "");
        const p = this.runTask(t).finally(() => {
          running.delete(t.id);
          this.busy.delete(t.assignee_agent_id ?? "");
          this.settleUnread(this.team.find((a) => a.id === t.assignee_agent_id));
        });
        running.set(t.id, p);
      }
      if (!running.size && this.answering.size) {
        // An agent answering a message may hold back its own next task: wait for it rather than finishing early.
        this.wake = deferred<void>();
        await Promise.race([...this.answering, this.wake.promise]);
        continue;
      }
      if (!running.size) {
        if (worked && !this.state.questions.length && (await this.verify())) continue;
        break;
      }
      // Wake for a finished task or for a message from the user, so a mid-run message is planned while the team works.
      this.wake = deferred<void>();
      await Promise.race([...running.values(), this.wake.promise]);
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
    this.phase(task.kind === "review" ? "review" : task.kind === "verify" ? "verify" : "build", "active");
    const deps = this.tasks.filter((d) => task.depends_on.includes(d.key));
    const work = task.kind === "review" ? this.tasks.find((x) => x.key === task.depends_on[0]) : undefined;
    const author = (w: TaskOut) => this.team.find((a) => a.id === w.assignee_agent_id)?.name ?? "a teammate";
    const resume = this.state.resume[task.id];
    delete this.state.resume[task.id];
    let mode: Mode;
    let session: string;
    let brief: string;
    let fresh: boolean;
    let preload: { path: string; content: string }[] = [];
    if (task.kind === "verify") {
      // The verifier keeps one session per cycle: a re-check after fixes looks only at what failed.
      mode = "acceptance";
      session = `${agent.id}:acceptance`;
      fresh = !this.liveSession(session);
      const reqs = this.state.requirements.filter((r) => task.requirements.includes(r.id) && r.status !== "cut");
      const cycle = this.tasks.slice(this.state.cycle_from);
      const built = cycle.filter((t) => (t.kind === "build" || t.kind === "fix" || t.kind === "docs") && t.status === "done");
      const lastCheck = cycle.findLastIndex((t) => t.kind === "verify" && t.id !== task.id && t.status === "done");
      const fixes = cycle.slice(lastCheck + 1).filter((t) => t.kind === "fix" && t.status === "done").map((t) => ({ key: t.key, who: author(t), result: t.result }));
      brief = !fresh && lastCheck >= 0 && fixes.length
        ? reAcceptanceBrief({ requirements: reqs, fixes })
        : acceptanceBrief({ goal: this.row.goal, requirements: reqs, work: built.map((t) => ({ key: t.key, title: t.title, who: author(t), result: t.result })),
          files: [...new Set(built.flatMap((t) => this.state.files_by_task[t.id] ?? []))],
          scripts: projectTasks(this.p.fs).slice(0, 12).map((t) => `- ${t.name}: \`${t.command}\`${t.kind === "server" ? " (dev server: use start_dev_server)" : ""}`).join("\n") });
    } else if (task.kind === "review" && work) {
      // A critic who already reviewed this work continues: it checks its own comments against the change since then.
      session = `${agent.id}:review:${this.state.continues[work.id] ?? work.id}`;
      const lens = lensOf(agent);
      // Only a code review can be judged from a diff alone; looking at or playing the product needs the full toolset.
      const small = lens === "code" ? this.smallChange(work) : null;
      const prior = this.liveSession(session);
      if (prior && prior.mode !== "reviewer" && !small) this.sessions.delete(session);
      const cont = this.liveSession(session);
      mode = cont?.mode ?? (small ? "quick_review" : "reviewer");
      fresh = !cont;
      const round = (this.state.revisions[work.id] ?? 0) + 1;
      const diff = this.state.diffs_by_task[work.id];
      brief = cont && resume
        ? revisionNote(task, resume, "Then give your verdict with submit_review.")
        : cont
        ? reReviewBrief(work, { author: author(work), summary: work.result, files: diff?.files ?? [], round, diff: diff?.text ?? "", lens })
        : reviewBrief(work, { goal: this.row.goal, author: author(work), summary: work.result, files: this.state.files_by_task[work.id] ?? [], round, diff: small?.text,
          previous: round > 1 ? this.state.feedback[work.id] : undefined, requirements: this.state.requirements, lens, pins: this.pinsFor(work.files) });
    } else {
      mode = "worker";
      session = `${agent.id}:${this.state.continues[task.id] ?? task.id}`;
      fresh = !this.liveSession(session);
      if (fresh) preload = this.depDocs(deps);
      brief = !fresh && resume ? revisionNote(task, resume, "Address every point and verify the result, then call complete_task.") : taskBrief(task, { goal: this.row.goal, deps, team: this.team, feedback: this.state.feedback[task.id],
        answer: this.state.answers[task.id], requirements: this.state.requirements, docs: preload, pins: this.pinsFor(task.files) });
    }
    let stop: Stop | null = null;
    let text = "";
    let exhausted = false;
    try {
      const content = fresh && this.requestImages.length ? [{ type: "input_text", text: brief }, ...this.requestImages] : brief;
      const res = await this.turn(agent, mode, task, [{ role: "user", content }], { session, preload, maxRounds: STEPS[mode] ?? 3 });
      stop = res.stop;
      text = res.text;
      exhausted = !!res.exhausted;
    } catch (e) {
      if (e instanceof Halt || this.stopped) { this.pendingHalt ??= { reason: e instanceof Halt ? e.message : "Stopped", status: this.stopped && !(e instanceof Halt) ? "cancelled" : "incomplete" }; this.abort.abort(); return; }
      const message = (e as Error).message;
      this.emit("error", { message: `${agent.name}: ${message}`, kind: "error", agent_id: agent.id });
      if (task.attempts < 2 && !(e instanceof UserError && /not connected|401|403|404/.test(message))) { this.saveTask({ ...this.latest(task), status: "todo" }); return; }
      this.saveTask({ ...this.latest(task), status: "blocked", result: `Failed: ${message}` });
      this.criticFailed(task, agent, message);
      return;
    }
    try {
      // The lead may have amended the task during the turn: settle the stored version, not the copy taken at the start.
      await this.settle(this.latest(task), agent, stop, text, exhausted);
    } catch (e) {
      this.emit("error", { message: `${agent.name}: ${(e as Error).message}`, kind: "error", agent_id: agent.id });
      this.saveTask({ ...this.latest(task), status: "blocked", result: `Could not be completed: ${(e as Error).message}` });
      this.criticFailed(task, agent, (e as Error).message);
    }
  }

  /** A critic that failed still counts as finished in its round, so the round can close on the others' verdicts. */
  private criticFailed(task: TaskOut, agent: AgentOut, reason: string) {
    if (task.kind !== "review") return;
    const work = this.tasks.find((x) => x.key === task.depends_on[0]);
    if (!work) return;
    this.state.verdicts[task.id] = { critic: agent.name, lens: lensOf(agent), verdict: "none", comments: reason };
    this.closeRound(work, task.id);
  }

  private latest(t: TaskOut): TaskOut { return this.tasks.find((x) => x.id === t.id) ?? t; }

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
      this.state.resume[task.id] = { from: "No verdict yet", text: "You stopped without giving a verdict." };
      this.saveTask({ ...task, status: "todo" }); // the reviewer did not give a verdict: ask again
      return;
    }
    if (task.kind === "verify") return this.settleAcceptance(task, agent, stop, exhausted);
    // A turn must end with the tool that submits its result. Prose alone is not a finished task, so it is blocked
    // (and shown to the user) rather than recorded as done.
    if (stop?.kind === "block" || !stop) {
      const reason = stop?.kind === "block" ? stop.reason
        : task.kind === "review" ? "The reviewer did not give a verdict."
        : exhausted ? "Ran out of steps before finishing."
        : "Stopped without calling complete_task, so nothing was submitted as finished.";
      this.saveTask({ ...task, status: "blocked", result: reason });
      this.post({ from: agent.id, to: lead.id, type: "status_update", content: `Blocked on ${task.key}: ${reason}`, meta: { task_id: task.key } });
      const work = task.kind === "review" ? this.tasks.find((x) => x.key === task.depends_on[0]) : undefined;
      if (work) {
        this.state.verdicts[task.id] = { critic: agent.name, lens: lensOf(agent), verdict: "none", comments: reason };
        this.closeRound(work, task.id);
      }
      return;
    }
    if (task.kind === "review") {
      const work = this.tasks.find((x) => x.key === task.depends_on[0]);
      if (stop?.kind !== "review") return;
      const { verdict, comments, findings } = stop;
      this.saveTask({ ...task, status: "done", result: `${verdict === "approve" ? "Approved" : "Changes requested"}: ${comments}` });
      if (!work) return;
      const recorded = addFindings(this.findingsOf(work.id), agent.name, findings);
      this.setFindings(work.id, recorded.list);
      this.state.verdicts[task.id] = { critic: agent.name, lens: lensOf(agent), verdict, comments, findings: recorded.added };
      this.post({ from: agent.id, to: work.assignee_agent_id, type: "review_result", content: comments,
        meta: { verdict, task_id: work.key, review: { revisions: this.state.revisions[work.id] ?? 0, max_revisions: this.budget.max_revisions } } });
      this.closeRound(work, task.id);
      return;
    }
    if (stop?.kind === "complete" && (task.kind === "build" || task.kind === "fix")) {
      // Findings belong to the work item, and a revision (a fix after review or after a failed acceptance) continues
      // that same item: it answers the item's findings, not an empty list of its own.
      const workId = this.state.continues[task.id] ?? task.id;
      const answered = answerFindings(this.findingsOf(workId), stop.responses ?? []);
      this.setFindings(workId, answered.list);
      const open = blockingOpen(answered.list);
      if (open.length || answered.unknown.length) {
        const why = [
          open.length ? `Answer each open finding before finishing: ${open.map((f) => f.id).join(", ")}.` : "",
          answered.unknown.length ? `These ids match no finding: ${answered.unknown.join(", ")}.` : "",
        ].filter(Boolean).join(" ");
        const tries = (this.state.gate_tries?.[task.id] ?? 0) + 1;
        this.state.gate_tries = { ...(this.state.gate_tries ?? {}), [task.id]: tries };
        if (tries >= 3) {
          this.saveTask({ ...task, status: "blocked", result: why });
          this.post({ from: agent.id, to: lead.id, type: "status_update", content: `Blocked on ${task.key}: ${why}`, meta: { task_id: task.key } });
          return;
        }
        this.state.resume[task.id] = { from: "Open findings", text: `${why}\n\n${renderFindings(open)}` };
        this.saveTask({ ...task, status: "todo" });
        return;
      }
    }
    const summary = stop?.kind === "complete" ? `${stop.summary}${stop.verification ? `\n\nVerified: ${stop.verification}` : ""}` : text;
    const changed = (this.state.files_by_task[task.id] ?? []).length > 0;
    this.post({ from: agent.id, to: agent.reports_to ?? lead.id, type: "status_update", content: summary, meta: { task_id: task.key } });
    const reviewed = this.budget.review && (task.kind === "build" || task.kind === "fix") && changed && this.riskOf(task, agent) !== "trivial";
    if (reviewed) {
      this.saveTask({ ...task, status: "review", result: summary });
      // Every specialist on this part critiques the same round in parallel; the owner gets their feedback together.
      const ids: string[] = [];
      for (const critic of this.reviewersFor(task, agent)) {
        const lens = lensOf(critic);
        const t = this.newTask({ title: `${LENS[lens].title} ${task.key}: ${task.title.replace(/^Revise: /, "")}`, description: `${LENS[lens].title} of ${agent.name}'s work on ${task.key}.`,
          acceptance_criteria: "", assignee_agent_id: critic.id, kind: "review", depends_on: [task.key], created_by: lead.id });
        ids.push(t.id);
        this.post({ from: agent.id, to: critic.id, type: "review_request", content: `Please review ${task.key}: ${task.title} (${LENS[lens].name})`, meta: { task_id: task.key } });
      }
      this.state.rounds[task.id] = ids;
      return;
    }
    this.saveTask({ ...task, status: "done", result: summary });
  }

  /**
   * Who sharpens a part: the specialists the lead attached to it, plus a code reviewer unless one of them already
   * reviews code. Nobody reviews their own work.
   */
  /**
   * Who reviews this revision. A critic that already approved this work item keeps its approval: only the critics who
   * asked for changes read the revision, so a fix costs one review instead of one per lens. A change nobody objected to
   * still goes to one critic, so no change ships unreviewed.
   */
  private reviewersFor(work: TaskOut, author: AgentOut): AgentOut[] {
    const all = this.criticsFor(work, author);
    const prior = this.priorVerdicts(this.state.continues[work.id] ?? work.id);
    if (!prior.size) return all;
    const wanted = all.filter((a) => prior.get(a.id) !== "approve");
    return wanted.length ? wanted : all.slice(0, 1);
  }

  /** The latest verdict of each critic on a work item, across the revisions already completed. */
  private priorVerdicts(workId: string): Map<string, string> {
    const keys = new Set(this.tasks.filter((t) => (this.state.continues[t.id] ?? t.id) === workId).map((t) => t.key));
    const out = new Map<string, string>();
    for (const t of this.tasks) {
      if (t.kind !== "review" || !keys.has(t.depends_on[0] ?? "")) continue;
      const v = this.state.verdicts[t.id];
      const critic = v && this.team.find((a) => a.name === v.critic);
      if (v && critic) out.set(critic.id, v.verdict);
    }
    return out;
  }

  private criticsFor(work: TaskOut, author: AgentOut): AgentOut[] {
    const attached = work.specialists.map((id) => this.team.find((a) => a.id === id)).filter((a): a is AgentOut => !!a);
    const named = attached.filter((a) => a.id !== author.id && canReview(a));
    // A specialist that cannot critique is never dropped in silence: the plan the user saw must match what happens.
    for (const a of attached) {
      if (a.id === author.id || canReview(a)) continue;
      this.emit("error", { message: `${a.name} cannot review ${work.key} (${kindOf(a) === "writer" ? "writes files" : "cannot read the project"}), so another reviewer covers that lens.`, kind: "warning", agent_id: a.id });
    }
    const code = named.some((a) => lensOf(a) === "code") ? [] : [this.reviewerFor(author)].filter((a) => kindOf(a) !== "writer");
    return [...new Map([...code, ...named].map((a) => [a.id, a])).values()];
  }

  /**
   * When every critic of the current round has finished, decide: approved, or one revision for the owner with all the
   * requested changes together. A round where nobody could give a verdict blocks the work.
   */
  /** The findings kept for a part. Runs saved before findings existed have none. */
  private findingsOf(workId: string): Finding[] {
    return this.state.findings?.[workId] ?? [];
  }

  private setFindings(workId: string, list: Finding[]) {
    this.state.findings = { ...(this.state.findings ?? {}), [workId]: list };
  }

  private closeRound(work: TaskOut, reviewTaskId: string) {
    // A conversation saved before rounds were recorded has none: the review being settled is its whole round.
    const ids = this.state.rounds[work.id] ?? [reviewTaskId];
    if (ids.some((id) => !["done", "blocked", "cancelled"].includes(this.tasks.find((t) => t.id === id)?.status ?? "done"))) return;
    const current = this.latest(work);
    if (current.status !== "review") return;
    const verdicts = ids.map((id) => this.state.verdicts[id]).filter((v): v is Verdict => !!v);
    const given = verdicts.filter((v) => v.verdict !== "none");
    if (!given.length) {
      this.saveTask({ ...current, status: "blocked", result: `${current.result}\n\nNot reviewed: ${verdicts.map((v) => v.comments).join("; ") || "no verdict"}` });
      return;
    }
    this.setFindings(work.id, settlePrior(this.findingsOf(work.id))); // fixed or disputed findings are checked by this round
    delete this.state.diffs_by_task[work.id]; // the next round looks only at what changes after this one
    const changes = given.filter((v) => v.verdict === "request_changes");
    const merged = changes.map((v) => `### ${v.critic} (${LENS[v.lens].name})\n${v.comments}${v.findings?.length ? `\n\n${renderFindings(v.findings)}` : ""}`).join("\n\n");
    const rounds = this.state.revisions[work.id] ?? 0;
    if (!changes.length) {
      this.saveTask({ ...current, status: "done" });
      this.phase("review", "done");
      return;
    }
    if (rounds >= this.budget.max_revisions) {
      // Comments still open at the limit are not finished work: the part is blocked, and the run cannot be completed.
      this.state.open_comments[work.id] = merged;
      this.saveTask({ ...current, status: "blocked", result: `${current.result}\n\nOpen review comments (revision limit reached):\n${merged}` });
      this.phase("review", "failed", undefined, "Review comments still open at the revision limit");
      return;
    }
    this.state.revisions[work.id] = rounds + 1;
    this.state.feedback[work.id] = merged;
    this.state.resume[work.id] = { from: `review by ${changes.map((v) => v.critic).join(" and ")}`, text: merged };
    this.saveTask({ ...current, status: "todo", kind: "fix" as const, title: current.title.startsWith("Revise: ") ? current.title : `Revise: ${current.title}` });
  }

  /**
   * After the team's changes: the project's own checks, then the acceptance check against the requirements.
   * Returns true when it created work (a fix or an acceptance check), so the run keeps going.
   */
  private async verify(): Promise<boolean> {
    if (!this.budget.verify) return false;
    const changedTasks = this.tasks.slice(this.state.cycle_from).filter((t) => (t.kind === "build" || t.kind === "fix") && t.status === "done" && (this.state.files_by_task[t.id] ?? []).length);
    if (!changedTasks.length) return false;
    if (this.state.unchecked) {
      this.state.unchecked = false;
      if (await this.runChecks(changedTasks)) return true;
    }
    if (this.state.verification.some((v) => !v.ok)) return false;
    return this.requestAcceptance(changedTasks);
  }

  /** Run the project's own checks. Returns true when a fix task was created. */
  private async runChecks(changedTasks: TaskOut[]): Promise<boolean> {
    const changedFiles = [...new Set(changedTasks.flatMap((t) => this.state.files_by_task[t.id] ?? []))];
    const plan = planChecks(this.p.fs, changedFiles, this.checksPassed);
    if (plan.kind === "none") { this.phase("verify", "skipped", null, "The project has no automated checks"); return false; }
    if (plan.kind === "skipped") { this.phase("verify", "skipped", null, plan.reason); return false; }
    // The same files already passed these checks in this conversation: no new content, no new run.
    if (plan.kind === "passed") { this.phase("verify", "done", null, "The same changes already passed these checks"); return false; }
    const lead = this.lead;
    this.phase("verify", "active", lead.id);
    if (plan.left.length) this.emit("error", { message: `Checks left out, over the limit of ${CHECK_LIMIT}: ${plan.left.join(", ")}.`, kind: "warning", agent_id: lead.id });
    let callId = "";
    const results = await runCheckList(this.p.fs, plan.checks, this.abort.signal, {
      stopped: () => this.stopped,
      started: (c) => {
        callId = newId();
        this.setStatus(lead, "running", c.command);
        this.emit("tool_call", { call_id: callId, agent_id: lead.id, tool: "run_code", args: { command: c.command, cwd: c.directory } });
      },
      finished: (_c, ok, output) => this.emit("tool_result", { call_id: callId, agent_id: lead.id, tool: "run_code", ok, output: clip(output, 4000) }),
    });
    if (!results) return false;
    this.setStatus(lead, "idle");
    this.state.verification = results;
    this.state.usage.verifications += results.length;
    const failures = results.filter((r) => !r.ok);
    if (!failures.length) {
      this.checksPassed.add(plan.key);
      this.phase("verify", "done", lead.id, `${results.length} check${results.length > 1 ? "s" : ""} passed`);
      return false;
    }
    if (this.state.verify_rounds >= this.budget.max_revisions) { this.phase("verify", "failed", lead.id, "Checks still failing"); return false; }
    this.state.verify_rounds++;
    const last = changedTasks[changedTasks.length - 1]!;
    const owner = this.team.find((a) => a.id === last.assignee_agent_id) ?? lead;
    const report = failures.map((f) => `### ${f.name} (\`${f.command}\`) failed\n\`\`\`\n${f.output}\n\`\`\``).join("\n\n");
    const fix = this.newTask({ title: `Fix failing checks`, description: `The project's checks fail after the team's changes. Find the cause and fix it. If a failure was already there before this work and is unrelated, leave it and say so.\n\n${report}`,
      acceptance_criteria: failures.map((f) => `- \`${f.command}\` passes`).join("\n"), assignee_agent_id: owner.id, kind: "fix", depends_on: [], created_by: lead.id, files: last.files });
    this.state.continues[fix.id] = this.state.continues[last.id] ?? last.id;
    this.post({ from: lead.id, to: owner.id, type: "task", content: `Checks failed: ${failures.map((f) => f.name).join(", ")}. Please fix (${fix.key}).`, meta: { task_id: fix.key } });
    return true;
  }

  /**
   * Who checks the result against the requirements: a QA engineer, else someone with a browser who did not build it,
   * else a new QA engineer; when the team is full, anyone else who can run things. Null when nobody can.
   */
  private verifierFor(changedTasks: TaskOut[]): AgentOut | null {
    const authors = new Set(changedTasks.map((t) => t.assignee_agent_id));
    const pool = this.team.filter((a) => a.id !== this.lead.id && canVerify(a));
    const found = pool.find((a) => a.behavior.template_key === "qa") ?? pool.find((a) => a.tools.browser && !authors.has(a.id));
    if (found) return found;
    try {
      return this.hire({ role_key: "qa", title: "QA Engineer", department: "Quality & Ops", reason: "Checks the finished work against what you asked for", manager: false }, this.lead);
    } catch {
      return pool.find((a) => !authors.has(a.id)) ?? pool[0] ?? null; // the team is full
    }
  }

  /** Queue an acceptance check of the requirements not yet met. Returns true when one was queued. */
  private requestAcceptance(changedTasks: TaskOut[]): boolean {
    // Nothing changed since the last check was queued (it blocked, or found nothing to fix): asking again would repeat it.
    if (!this.state.unaccepted) return false;
    const pending = this.cycleRequirements().filter((r) => r.status === "open" || r.status === "unmet");
    if (!pending.length || this.tasks.some((t) => t.kind === "verify" && ["todo", "in_progress"].includes(t.status))) return false;
    if (this.state.acceptance_rounds > this.budget.max_revisions) {
      this.phase("verify", "failed", this.lead.id, `${pending.map((r) => r.id).join(", ")} not met`);
      return false;
    }
    this.state.acceptance_rounds++;
    const verifier = this.verifierFor(changedTasks);
    if (!verifier) { this.phase("verify", "skipped", null, "No one on the team can run the product to check it"); return false; }
    this.state.unaccepted = false;
    const ids = pending.map((r) => r.id);
    const t = this.newTask({ title: `Acceptance check: ${ids.join(", ")}`, description: "Check the finished product against these requirements, in the user's words.", acceptance_criteria: "",
      assignee_agent_id: verifier.id, kind: "verify", depends_on: [], created_by: this.lead.id, requirements: ids });
    this.post({ from: this.lead.id, to: verifier.id, type: "task", content: `Please check the result against ${ids.join(", ")} (${t.key}).`, meta: { task_id: t.key } });
    this.phase("verify", "active", verifier.id);
    return true;
  }

  /** Record the verdict on each requirement; what is not met goes back to the task that owns it. */
  private settleAcceptance(task: TaskOut, agent: AgentOut, stop: Stop | null, exhausted: boolean) {
    if (stop?.kind !== "acceptance") {
      const reason = stop?.kind === "block" ? stop.reason : exhausted ? "Ran out of steps before checking every requirement." : "Stopped without a verdict.";
      this.saveTask({ ...task, status: "blocked", result: reason });
      this.phase("verify", "failed", agent.id, "The acceptance check did not finish");
      this.post({ from: agent.id, to: this.lead.id, type: "status_update", content: `Blocked on ${task.key}: ${reason}`, meta: { task_id: task.key } });
      return;
    }
    const verdicts = new Map(stop.results.map((r) => [r.id, r]));
    this.setRequirements(this.state.requirements.map((r) => {
      if (!task.requirements.includes(r.id) || r.status === "cut") return r; // a requirement cut meanwhile stays cut
      const v = verdicts.get(r.id)!;
      return { ...r, status: v.met ? "met" : "unmet", note: v.evidence };
    }));
    const unmet = this.state.requirements.filter((r) => task.requirements.includes(r.id) && r.status === "unmet");
    const summary = `${task.requirements.length - unmet.length} of ${task.requirements.length} met.${unmet.map((r) => `\n- ${r.id} not met: ${r.note}`).join("")}`;
    this.saveTask({ ...task, status: "done", result: summary });
    this.post({ from: agent.id, to: this.lead.id, type: "status_update", content: summary, meta: { task_id: task.key } });
    if (!unmet.length) { this.phase("verify", "done", agent.id, "Every requirement met"); return; }
    if (this.state.acceptance_rounds > this.budget.max_revisions) { this.phase("verify", "failed", agent.id, `${unmet.map((r) => r.id).join(", ")} not met`); return; }
    const built = this.tasks.filter((t) => writes(t) && t.status === "done" && (this.state.files_by_task[t.id] ?? []).length);
    const groups = new Map<TaskOut, Requirement[]>();
    for (const r of unmet) {
      const owner = built.findLast((t) => t.requirements.includes(r.id)) ?? built.at(-1);
      if (owner) groups.set(owner, [...(groups.get(owner) ?? []), r]);
    }
    for (const [owner, reqs] of groups) {
      const ids = reqs.map((r) => r.id);
      const fix = this.newTask({ title: `Make ${ids.join(", ")} work`, kind: "fix", depends_on: [], created_by: this.lead.id, assignee_agent_id: owner.assignee_agent_id,
        description: `${agent.name}'s acceptance check found these requirements not met in the running product:\n\n${reqs.map((r) => `- ${r.id}: ${r.text}\n  Observed: ${r.note}`).join("\n")}\n\nFix them, then check them yourself the same way.`,
        acceptance_criteria: reqs.map((r) => `- ${r.id} works as the user asked: ${r.text}`).join("\n"), requirements: ids, files: owner.files, skills: owner.skills });
      this.state.continues[fix.id] = this.state.continues[owner.id] ?? owner.id;
      this.post({ from: this.lead.id, to: owner.assignee_agent_id, type: "task", content: `Not accepted yet: ${ids.join(", ")}. Please fix (${fix.key}).`, meta: { task_id: fix.key } });
    }
    // A fix for a requirement found unmet has to be checked as well, or the requirement is never accepted.
    if (groups.size) this.state.unaccepted = true;
  }

  private async report() {
    const lead = this.lead;
    this.phase("report", "active", lead.id);
    const who = (id: string | null) => this.team.find((a) => a.id === id)?.name ?? "?";
    const cycle = this.tasks.slice(this.state.cycle_from);
    const tasks = cycle.map((t) => `- ${t.key} [${t.status}] ${t.title} (${who(t.assignee_agent_id)}): ${clip(t.result, 800)}`).join("\n");
    const files = [...new Set(cycle.flatMap((t) => this.state.files_by_task[t.id] ?? []))];
    const checks = this.state.verification.map((v) => `- ${v.name}: ${v.ok ? "passed" : "failed"}`).join("\n");
    const unresolved = this.unresolvedIn(cycle);
    const outcome = outcomeSection({
      requirements: this.cycleRequirements(),
      open: [
        ...cycle.filter((t) => t.status === "blocked" && !this.state.open_comments[t.id]).map((t) => `${t.key} ${t.title} (${who(t.assignee_agent_id)}) is blocked: ${firstLine(t.result, 300)}`),
        ...cycle.filter((t) => this.state.open_comments[t.id]).map((t) => `${t.key} ${t.title.replace(/^Revise: /, "")}: review comments still open after ${this.budget.max_revisions} revisions: ${clip(this.state.open_comments[t.id]!.replace(/^### (.+)\n/gm, "$1: ").replace(/\s*\n+\s*/g, " "), 400)}`),
        ...this.state.verification.filter((v) => !v.ok).map((v) => `\`${v.command}\` fails.`),
      ],
    });
    const prompt = [
      `The team has finished working on the latest request. Write your reply to the user now, in Markdown, without calling tools.`,
      `Lead with the outcome in one or two sentences. Then: what changed and where (files), how it was verified, and how to run or try it. Be specific and honest; do not oversell. Keep it short.`,
      outcome && `The section below is added to your reply as it is. Do not repeat it, and do not claim anything it contradicts (a fix it lists as open, a requirement it lists as not met).\n\n${outcome}`,
      `## Tasks\n${tasks}`, files.length ? `## Files changed\n${files.map((f) => `- ${f}`).join("\n")}` : "", checks ? `## Automated checks\n${checks}` : "",
    ].filter(Boolean).join("\n\n");
    // A plain cycle needs no narrator: the owner already wrote what it changed and how it verified it, and the engine
    // appends the requirement table either way. Only a cycle with something to explain gets a model-written report.
    const plain = !this.cycleRequirements().length && !unresolved.length
      && !cycle.some((t) => t.status === "blocked" || this.state.open_comments[t.id] || this.state.revisions[t.id])
      && this.state.verification.every((v) => v.ok);
    let text = plain ? this.factualReport(cycle, files) : "";
    if (!plain) try {
      const res = await this.turn(lead, "report", null, [{ role: "user", content: `${this.state.history.findLast((h) => h.role === "user")?.content ?? this.row.goal}` }, { role: "developer", content: prompt }], { maxRounds: 2 });
      text = res.text;
    } catch (e) {
      if (e instanceof Halt || this.stopped) throw e;
      text = `The work is done, but I could not write the summary (${(e as Error).message}).\n\n${tasks}`;
    }
    this.phase("report", "done", lead.id);
    this.finishCycle([text || "Done.", outcome].filter(Boolean).join("\n\n"), this.cycleStatus(cycle), files);
  }

  /**
   * A cycle is completed only when nothing in it is blocked, failed, unmet, unchecked or left open by a reviewer. A
   * requirement that was never checked is not a met requirement, so open counts as unresolved too.
   */
  private cycleStatus(cycle: TaskOut[]): RunStatus {
    const blocked = cycle.some((t) => t.status === "blocked") || this.state.verification.some((v) => !v.ok);
    const owed = this.cycleRequirements().some((r) => r.status === "open" || r.status === "unmet");
    return blocked || owed || this.unresolvedIn(cycle).length ? "incomplete" : "completed";
  }

  /** Blocking review findings of the parts this cycle touched that no later review round has settled. */
  private unresolvedIn(cycle: TaskOut[]): Finding[] {
    const parts = new Set(cycle.map((t) => this.state.continues[t.id] ?? t.id));
    return [...parts].flatMap((id) => unresolvedBlocking(this.findingsOf(id)));
  }

  /** The report of a plain, verified cycle: the team's own summaries, the files, the checks. No extra model call. */
  private factualReport(cycle: TaskOut[], files: string[]): string {
    const who = (id: string | null) => this.team.find((a) => a.id === id)?.name ?? "the team";
    const done = cycle.filter((t) => ["build", "fix", "docs", "research"].includes(t.kind) && t.result.trim());
    return [
      done.length > 1 ? `Done — ${done.length} parts finished.` : "Done.",
      done.map((t) => `- ${firstLine(t.title.replace(/^Revise: /, ""), 80)} (${who(t.assignee_agent_id)}): ${clip(t.result.replace(/\s*\n+\s*/g, " "), 400)}`).join("\n"),
      files.length ? `**Files changed**\n${files.map((f) => `- ${f}`).join("\n")}` : "",
      this.state.verification.filter((v) => v.ok).length ? `**Checks**\n${this.state.verification.filter((v) => v.ok).map((v) => `- ${v.name}: passed`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  private finishCycle(text: string, status: RunStatus, files: string[] = []) {
    const lead = this.lead;
    this.post({ from: lead.id, to: null, type: "final_report", content: text, meta: { files } });
    this.state.history.push({ role: "assistant", content: text });
    this.row.report_md = appendRecap(this.row.report_md, this.state.history.findLast((h) => h.role === "user")?.content ?? this.row.goal, text);
    for (const a of this.team) this.setStatus(a, a.id === lead.id ? "done" : "idle");
    this.state.workflow.ended = true;
    this.setRunStatus(status, { summary: firstLine(text, 300), reason: status === "incomplete" ? "Some tasks could not be finished" : "" });
    this.state.workflow = initialState().workflow;
    this.state.verify_rounds = 0;
    this.state.acceptance_rounds = 0;
    this.state.cycle_from = this.tasks.length;
    this.state.req_from = this.state.requirements.length;
    // Sessions survive the cycle: the lead keeps what it learned about the project and the next request starts warmer.
    // An oversized one is dropped (liveSession already refuses it) so a long conversation stays bounded.
    for (const [key, s] of this.sessions) if (this.oversized(s)) this.sessions.delete(key);
  }

  /** For deleting a conversation: stop it and forget it. */
  static discard(runId: string) {
    const c = live.get(runId);
    if (c) { c.abort.abort(); if (c.startedServer) processes(c.p.id).server.stop(); live.delete(runId); }
  }
}
