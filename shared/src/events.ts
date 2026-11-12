/**
 * Run events: everything the web app sees of a conversation arrives as one of these, live over the run WebSocket or
 * replayed from the event log. `seq` orders persisted events; streaming deltas are live-only and carry no seq.
 */
import type {
  AgentOut, AgentStatus, ArtifactOut, EdgeOut, MessageOut, PendingApproval, RunStatus, TaskOut,
} from "./domain.js";

export interface Question { agent_id: string; question: string; options: { label: string; description?: string; recommended?: boolean }[]; allow_other: boolean }
export interface Usage {
  tokens: number; cost_usd: number; turns: number; max_turns: number; max_tokens: number; max_cost_usd: number;
  timeout_s: number; active_seconds: number; input_tokens: number; cached_tokens: number; output_tokens: number;
  reasoning_tokens: number; llm_calls: number; per_agent: Record<string, number>; per_agent_cost: Record<string, number>;
  cost_breakdown: { input: number; cached_input: number; output: number };
}
export type PhaseStatus = "pending" | "active" | "done" | "skipped" | "failed";
export interface WorkflowPhase { key: string; title: string; owner: string | null; status: PhaseStatus; loops?: number; summary?: string }
export interface WorkflowState { track: string | null; index: number; ended: boolean; reason?: string; phases: WorkflowPhase[] }

export interface RunEventMap {
  snapshot: { status: RunStatus; live: boolean; agent_status: Record<string, AgentStatus>; activity: Record<string, string>; pending_approval: PendingApproval | null; awaiting: Question | null; usage: Usage };
  replay_done: { last_seq: number };
  run_status: { status: RunStatus; reason?: string; summary?: string; final?: boolean; awaiting?: Question | null; pending_approval?: PendingApproval | null };
  run_continued: { content: string };
  agent_status: { agent_id: string; status: AgentStatus; activity?: string };
  turn_started: { agent_id: string; task_key?: string };
  token_stream: { agent_id: string; delta: string };
  thinking_stream: { agent_id: string; delta: string };
  thought: { agent_id: string; text: string };
  message_created: { message: MessageOut };
  edge_activity: { edge_id: string; from_agent_id: string; type: string };
  tool_call: { call_id: string; agent_id: string; tool: string; args: Record<string, unknown> };
  tool_result: { call_id: string; agent_id: string; tool: string; ok: boolean; output: string };
  browser_action: { agent_id: string; call_id: string; tool: string; args: Record<string, unknown>; ok: boolean; url: string; title: string; frame: string | null; note?: string };
  task_updated: { task: TaskOut };
  artifact_updated: { artifact: ArtifactOut & { created: boolean; lines: number; previous_lines: number } };
  workflow_updated: { workflow: WorkflowState };
  usage_update: Usage;
  approval_requested: PendingApproval;
  approval_resolved: { id: string; approved: boolean; reason?: string; agent_id: string; kind: string; summary: string; auto?: boolean };
  agent_created: { agent: AgentOut; edges: EdgeOut[]; created_by: string; persisted: boolean; reason: string; department?: { name: string; color: string } };
  agent_updated: { agent_id: string; by: string; changes: Partial<AgentOut>; old_name: string; summary: string; reason: string; self: boolean; persisted: boolean };
  agent_finished: { agent_id: string };
  file_moved: { from: string; to: string };
  error: { message: string; kind?: "warning" | "error" | "client"; agent_id?: string };
}
export type RunTopic = keyof RunEventMap;
/** Streaming deltas are fanned out to live sockets but never stored. */
export const EPHEMERAL_TOPICS: ReadonlySet<RunTopic> = new Set(["token_stream", "thinking_stream"]);

export interface RunEventEnvelope<T extends RunTopic = RunTopic> { type: T; run_id: string; data: RunEventMap[T]; seq?: number; ts: string; replay?: boolean }

/** What the browser may send on the run socket. */
export type RunClientMessage =
  | { type: "pong" }
  | { type: "interject" | "user_message" | "continue"; content: string; to_agent_id?: string | null; attachments?: unknown[] }
  | { type: "control"; action: "pause" | "resume" | "step" | "stop" }
  | { type: "approve" | "reject"; approval_id: string; scope?: "once" | "always"; reason?: string };

/** Direct chat socket: server → browser, as `{ type, data }`. */
export interface ChatEventMap {
  stream_start: { message_id: string; agent_id: string };
  status: { message_id: string; phase: "thinking" | "writing" | "tool"; detail: string; model?: string };
  token_stream: { message_id: string; delta: string };
  stream_reset: { message_id: string };
  tool_call: { message_id: string; call: { name: string; args: unknown; result?: string } };
  stream_end: { message: MessageOut };
  message_created: { message: MessageOut };
  message_deleted: { id: string };
  error: { message: string };
  ping: Record<string, never>;
}
export type ChatTopic = keyof ChatEventMap;
export type ChatClientMessage =
  | { type: "user_message"; content: string; attachments?: { filename: string; text: string }[] }
  | { type: "stop" } | { type: "regenerate" } | { type: "pong" };
