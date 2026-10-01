import type { AwaitingQuestion } from "./QuestionCard";
/** Pure reducer turning run events (live or replayed) into view state. Used for live runs and timeline scrubbing. */
import type { AgentOut, EdgeOut, MessageOut, PendingApproval, RunEvent } from "@/types";

export interface ToolCall { call_id: string; agent_id: string; tool: string; args: Record<string, unknown>; ok?: boolean; output?: string; turn_no?: number; seq?: number }
export interface LiveTask { key: string; title: string; status: string; assignee_agent_id?: string | null; description?: string; acceptance_criteria?: string }
export interface LiveArtifact { id: string; path: string; version: number; author_agent_id?: string | null; change_note?: string; planned?: boolean; created?: boolean; size?: number; lines?: number; previous_lines?: number; created_at?: string }
export interface TimelineItem { seq: number; type: string; ts?: string; agent_id?: string | null; label: string; tone: "msg" | "protocol" | "file" | "tool" | "status" | "error" | "approval" | "org" }
export interface OrgEvent { seq: number; kind: "created" | "updated"; by: string; agent_id: string; name: string; role?: string; department?: string; summary?: string; reason?: string; self?: boolean; persisted?: boolean; ts?: string }
export type FeedMessage = MessageOut & { _seq?: number };
export interface Usage {
  tokens: number; cost_usd: number; turns: number; max_turns?: number; max_tokens?: number; max_cost_usd?: number; per_agent?: Record<string, number>;
  active_seconds?: number; timeout_s?: number;
  /** exact provider usage: input includes cached + cache-write tokens, output includes reasoning tokens */
  input_tokens?: number; cached_tokens?: number; cache_write_tokens?: number; output_tokens?: number; reasoning_tokens?: number; llm_calls?: number; estimated_calls?: number;
  cost_breakdown?: { input?: number; cached_input?: number; cache_write?: number; output?: number };
  per_agent_cost?: Record<string, number>;
  /** last turn that changed a file or moved the task board, and how many turns ago that was */
  progress_turn?: number; turns_since_progress?: number;
}
export interface ProtocolState { kind: "debate" | "review"; result: string; edge_id: string; state: Record<string, any>; seq?: number } // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RunLive {
  status: string;
  reason: string;
  summary: string;
  agentStatus: Record<string, string>;
  activity: Record<string, string>;
  streaming: Record<string, string>;
  thoughts: Record<string, string>;
  messages: FeedMessage[];
  extraAgents: AgentOut[];
  extraEdges: EdgeOut[];
  agentPatches: Record<string, Partial<AgentOut>>;
  orgEvents: OrgEvent[];
  fresh: Record<string, number>;
  departments: Record<string, { color: string }>;
  rejected: Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  toolCalls: Record<string, ToolCall>;
  tasks: Record<string, LiveTask>;
  artifacts: Record<string, LiveArtifact>;
  usage: Usage;
  activeEdges: Record<string, { at: number; from: string; type: string; seq?: number }>;
  lastMessage: Record<string, { text: string; type: string; to?: string }>;
  protocols: Record<string, ProtocolState>;
  pendingApproval: PendingApproval | null;
  awaiting: AwaitingQuestion | null;
  errors: Array<{ message: string; kind?: string; agent_id?: string; seq?: number; ts?: string }>;
  timeline: TimelineItem[];
  approvals: Array<{ id: string | null; approved: boolean; reason?: string; agent_id?: string; kind?: string; summary?: string; auto?: boolean; seq?: number }>;
  lastSeq: number;
  live: boolean;
  replayDone: boolean;
}

export const initialRun = (): RunLive => ({
  status: "queued", reason: "", summary: "", agentStatus: {}, activity: {}, streaming: {}, thoughts: {}, messages: [], rejected: [],
  extraAgents: [], extraEdges: [], agentPatches: {}, orgEvents: [], fresh: {}, departments: {},
  toolCalls: {}, tasks: {}, artifacts: {}, usage: { tokens: 0, cost_usd: 0, turns: 0 }, activeEdges: {}, lastMessage: {}, protocols: {},
  pendingApproval: null, awaiting: null, errors: [], timeline: [], approvals: [], lastSeq: 0, live: false, replayDone: false,
});

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function reduceRun(s: RunLive, e: RunEvent, names: Record<string, string> = {}): RunLive {
  const d = e.data ?? {};
  const seq = e.seq ?? 0;
  const now = e.replay ? Date.parse(e.ts ?? "") || Date.now() : Date.now();
  const n = (id?: string | null) => (id ? names[id] ?? s.extraAgents.find((x) => x.id === id)?.name ?? "Agent" : "User");
  const push = (item: Omit<TimelineItem, "seq" | "ts">) => (seq ? [...s.timeline, { ...item, seq, ts: e.ts }] : s.timeline);
  const next: RunLive = { ...s, lastSeq: Math.max(s.lastSeq, seq) };
  switch (e.type) {
    case "snapshot":
      return { ...next, status: d.status ?? s.status, live: !!d.live, agentStatus: { ...s.agentStatus, ...(d.agent_status ?? {}) },
        activity: { ...s.activity, ...(d.activity ?? {}) }, pendingApproval: d.pending_approval ?? null, awaiting: d.awaiting ?? null,
        usage: { ...s.usage, ...(d.usage ?? {}) } };
    case "replay_done":
      return { ...next, replayDone: true };
    case "run_status":
      return { ...next, status: d.status, reason: d.reason ?? s.reason, summary: d.summary ?? s.summary,
        awaiting: d.status === "awaiting_user" ? d.awaiting ?? s.awaiting : d.status === "running" ? null : s.awaiting,
        pendingApproval: d.pending_approval !== undefined ? d.pending_approval : s.pendingApproval,
        timeline: d.status === "running" && s.status === "running" ? s.timeline : push({ type: e.type, label: `Run ${d.status}${d.reason ? `: ${clip(d.reason, 60)}` : ""}`, tone: "status" }) };
    case "agent_status":
      return { ...next, agentStatus: { ...s.agentStatus, [d.agent_id]: d.status }, activity: { ...s.activity, [d.agent_id]: d.activity ?? "" },
        streaming: ["idle", "done", "waiting", "error"].includes(d.status) ? { ...s.streaming, [d.agent_id]: "" } : s.streaming };
    case "turn_skipped":
      return { ...next, timeline: push({ type: e.type, agent_id: d.agent_id, tone: "error", label: `${n(d.agent_id)} skipped: over ${d.limit} autonomous turns` }) };
    case "turn_started":
      return { ...next, streaming: { ...s.streaming, [d.agent_id]: "" }, thoughts: { ...s.thoughts, [d.agent_id]: "" } };
    case "token_stream":
      return { ...next, streaming: { ...s.streaming, [d.agent_id]: ((s.streaming[d.agent_id] ?? "") + d.delta).slice(-4000) } };
    case "thought":
      return { ...next, thoughts: { ...s.thoughts, [d.agent_id]: d.text } };
    case "message_created": {
      const m = d.message as MessageOut;
      if (s.messages.some((x) => x.id === m.id)) return next;
      const lm = m.from_agent_id && m.type !== "artifact_created"
        ? { ...s.lastMessage, [m.from_agent_id]: { text: clip(m.content, 160), type: m.type, to: m.to_agent_id ? n(m.to_agent_id) : undefined } } : s.lastMessage;
      return { ...next, messages: [...s.messages, { ...m, _seq: seq || undefined }], lastMessage: lm,
        awaiting: m.meta?.awaiting_input ? { agent_id: m.from_agent_id!, question: m.content, options: (m.meta.options as AwaitingQuestion["options"]) ?? [], allow_other: true } : s.awaiting,
        timeline: m.type === "artifact_created" ? s.timeline : push({ type: e.type, agent_id: m.from_agent_id, tone: "msg",
          label: `${n(m.from_agent_id)} › ${m.to_agent_id ? n(m.to_agent_id) : "you"} · ${m.type.replace("_", " ")}` }) };
    }
    case "edge_activity":
      return { ...next, activeEdges: { ...s.activeEdges, [d.edge_id]: { at: now, from: d.from_agent_id, type: d.type, seq } } };
    case "message_rejected":
      return { ...next, rejected: [...s.rejected, { ...d, seq }], timeline: push({ type: e.type, agent_id: d.from_agent_id, tone: "error", label: `Blocked ${n(d.from_agent_id)} › ${d.to}: ${clip(d.reason, 50)}` }) };
    case "tool_call":
      return { ...next, toolCalls: { ...s.toolCalls, [d.call_id]: { ...d, seq } as ToolCall } };
    case "tool_result": {
      const prev = s.toolCalls[d.call_id] ?? { call_id: d.call_id, agent_id: d.agent_id, tool: d.tool, args: {} };
      const important = d.tool === "run_code" || d.tool === "mcp_call";
      return { ...next, toolCalls: { ...s.toolCalls, [d.call_id]: { ...prev, ok: d.ok, output: d.output } },
        timeline: important ? push({ type: e.type, agent_id: d.agent_id, tone: d.ok ? "tool" : "error", label: `${n(d.agent_id)} ${d.tool === "run_code" ? "ran a command" : "called MCP"}: ${d.ok ? "ok" : "failed"}` }) : s.timeline };
    }
    case "task_updated": {
      const t = d.task as LiveTask;
      return { ...next, tasks: { ...s.tasks, [t.key]: t } };
    }
    case "artifact_updated": {
      const a = d.artifact as LiveArtifact;
      return { ...next, artifacts: { ...s.artifacts, [a.path]: a },
        timeline: push({ type: e.type, agent_id: a.author_agent_id, tone: "file", label: `${n(a.author_agent_id)} ${a.planned ? "planned" : a.version === 1 && a.created ? "created" : "updated"} ${a.path} v${a.version}` }) };
    }
    case "run_continued":
      return { ...next, status: "running", summary: "", timeline: push({ type: e.type, tone: "status", label: `Continued: ${clip(d.content, 60)}` }) };
    case "usage_update":
      return { ...next, usage: { ...s.usage, ...d } };
    case "protocol":
      return { ...next, protocols: { ...s.protocols, [`${d.kind}:${d.edge_id}:${d.kind === "review" ? d.state?.author : ""}`]: { ...(d as ProtocolState), seq } },
        timeline: push({ type: e.type, tone: "protocol", label: d.kind === "debate" ? `Debate ${d.result.replace("_", " ")}` : `Review ${d.result.replace("_", " ")}` }) };
    case "approval_requested":
      return { ...next, pendingApproval: d as PendingApproval, timeline: push({ type: e.type, agent_id: d.agent_id, tone: "approval", label: `Approval needed: ${clip(d.summary, 60)}` }) };
    case "approval_resolved":
      return { ...next, pendingApproval: s.pendingApproval?.id === d.id ? null : s.pendingApproval, approvals: [...s.approvals, { ...(d as RunLive["approvals"][number]), seq }] };
    case "error":
      return { ...next, errors: [...s.errors, { ...d, seq, ts: e.ts } as RunLive["errors"][number]],
        timeline: d.kind === "warning" ? s.timeline : push({ type: e.type, agent_id: d.agent_id, tone: "error", label: clip(d.message, 70) }) };
    case "agent_created": {
      const a = d.agent as AgentOut;
      if (s.extraAgents.some((x) => x.id === a.id)) return next;
      const dep = d.department as { name: string; color: string } | undefined;
      const nm = (id?: string | null) => (id && (names[id] ?? s.extraAgents.find((x) => x.id === id)?.name)) || "Agent";
      return { ...next, extraAgents: [...s.extraAgents, a], extraEdges: [...s.extraEdges, ...(d.edges as EdgeOut[])],
        fresh: { ...s.fresh, [a.id]: now }, departments: dep ? { ...s.departments, [dep.name]: { color: dep.color } } : s.departments,
        agentStatus: { ...s.agentStatus, [a.id]: "idle" },
        orgEvents: [...s.orgEvents, { seq, kind: "created", by: d.created_by, agent_id: a.id, name: a.name, role: a.role, department: a.department, persisted: d.persisted, ts: e.ts }],
        timeline: push({ type: e.type, agent_id: d.created_by, tone: "org", label: `${nm(d.created_by)} hired ${a.name} (${a.role})` }) };
    }
    case "agent_updated": {
      const ch = (d.changes ?? {}) as Partial<AgentOut>;
      const nm = (id?: string | null) => (id && (names[id] ?? s.extraAgents.find((x) => x.id === id)?.name)) || "Agent";
      return { ...next, agentPatches: { ...s.agentPatches, [d.agent_id]: { ...(s.agentPatches[d.agent_id] ?? {}), ...ch } },
        orgEvents: [...s.orgEvents, { seq, kind: "updated", by: d.by, agent_id: d.agent_id, name: ch.name ?? d.old_name, summary: d.summary, reason: d.reason, self: d.self, persisted: d.persisted, ts: e.ts }],
        timeline: push({ type: e.type, agent_id: d.by, tone: "org", label: d.self ? `${nm(d.by)} edited own config` : `${nm(d.by)} reconfigured ${d.old_name}` }) };
    }
    case "agent_finished":
      return next;
    default:
      return next;
  }
}

/** Rebuild state from persisted events up to (and including) `cursor` for timeline scrubbing. */
export function replayTo(events: RunEvent[], cursor: number, names: Record<string, string>): RunLive {
  let s = initialRun();
  for (const e of events) {
    if ((e.seq ?? 0) > cursor) break;
    s = reduceRun(s, { ...e, replay: true }, names);
  }
  // highlight the last few channel activities at the cursor position
  const recent = Object.entries(s.activeEdges).sort((a, b) => (b[1].seq ?? 0) - (a[1].seq ?? 0)).slice(0, 2);
  s.activeEdges = Object.fromEntries(recent.map(([k, v]) => [k, { ...v, at: Date.now() }]));
  s.streaming = {};
  return s;
}

export const TERMINAL = new Set(["completed", "incomplete", "failed", "cancelled"]);
