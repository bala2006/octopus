/**
 * The tool contract. A tool declares its arguments as a zod schema (sent to the model as JSON Schema and validated
 * before it runs) and gets a ToolContext: the one interface between tools and the engine.
 */
import { z } from "zod";
import type { AgentOut, AgentStatus, PendingApproval, RunEventMap, RunTopic, TaskOut } from "@octopus/shared";
import type { ProjectDb } from "../db/project";
import type { Registry } from "../db/registry";
import type { FunctionTool } from "../llm/azure";
import type { Risk } from "../safety/commands";
import type { ProjectFs } from "../safety/paths";

export interface GuardRequest {
  kind: string;
  risk: Exclude<Risk, "low" | "deny">;
  summary: string;
  preview?: string;
  details?: PendingApproval["details"];
  /** Approving "always" allows every later request with the same key in this conversation. */
  key: string;
}

/** How a tool can end the agent's turn on its task. */
export type Stop =
  | { kind: "complete"; summary: string; verification: string }
  | { kind: "review"; verdict: "approve" | "request_changes"; comments: string }
  | { kind: "ask"; question: string; options: { label: string; description?: string; recommended?: boolean }[] }
  | { kind: "block"; reason: string }
  | { kind: "plan_ready"; note: string }
  | { kind: "reply"; message: string };

export interface ToolResult { text: string; ok?: boolean; image?: string; stop?: Stop }

/** The most of one tool result an agent sees. read_file pages within it, so a read is never cut by the loop. */
export const MAX_TOOL_OUTPUT = 40_000;

/** File contents already in an agent's transcript: the content hash and the line ranges shown. */
export type Shown = Map<string, { hash: string; ranges: [number, number][] }>

export interface HireSpec { role_key?: string; title: string; name?: string; department: string; reports_to?: string; manager?: boolean; instructions?: string; reason: string }
export interface TaskSpec { title: string; description: string; acceptance_criteria: string; assignee: string; kind: TaskOut["kind"]; depends_on: string[] }

/** What the orchestrator's tools can do to the conversation (only present for the orchestrator). */
export interface Planner {
  hire(spec: HireSpec): AgentOut;
  addTask(spec: TaskSpec): TaskOut;
  tasks(): TaskOut[];
}

export interface ToolContext {
  agent: AgentOut;
  task: TaskOut | null;
  runId: string;
  fs: ProjectFs;
  db: ProjectDb;
  reg: Registry;
  signal: AbortSignal;
  /** Teammates by name or id (active agents in this conversation). */
  team(): AgentOut[];
  planner?: Planner;
  guard(req: GuardRequest): Promise<void>;
  emit<T extends RunTopic>(type: T, data: RunEventMap[T]): void;
  setStatus(status: AgentStatus, activity?: string): void;
  /** Version a file change: `before`/`after` null mean the file did not exist / was deleted. */
  recordFile(path: string, before: string | null, after: string | null, note: string): void;
  /** Content hash of each file as this agent last read or wrote it, to catch edits made in between. */
  seen: Map<string, string>;
  /** What this agent's transcript already holds, so an unchanged re-read costs a line instead of the file. */
  shown: Shown;
  /** Ask a teammate a question and wait for the answer. */
  consult(to: AgentOut, question: string): Promise<string>;
}

export interface Tool<A = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  name: string;
  description: string;
  args: z.ZodType<A>;
  /** JSON Schema sent to the model when it cannot be derived from `args` (MCP tools bring their own). */
  parameters?: Record<string, unknown>;
  run(ctx: ToolContext, args: A, callId: string): Promise<ToolResult>;
}

export const defineTool = <S extends z.ZodType>(t: { name: string; description: string; args: S; run(ctx: ToolContext, args: z.infer<S>, callId: string): Promise<ToolResult> }): Tool<z.infer<S>> =>
  t as unknown as Tool<z.infer<S>>;

export class Denied extends Error {}

export function toFunction(t: Tool): FunctionTool {
  if (t.parameters) return { type: "function", name: t.name, description: t.description.slice(0, 1000), parameters: t.parameters, strict: false };
  const schema = z.toJSONSchema(t.args, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return { type: "function", name: t.name, description: t.description, parameters: schema, strict: false };
}
