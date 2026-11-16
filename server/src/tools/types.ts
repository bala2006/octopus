/**
 * The tool contract. A tool declares its arguments as a zod schema (sent to the model as JSON Schema and validated
 * before it runs) and gets a ToolContext: the one interface between tools and the engine.
 */
import { z } from "zod";
import type { AgentOut, AgentStatus, PendingApproval, Requirement, RunEventMap, RunTopic, TaskOut } from "@octopus/shared";
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

import type { Answer, FindingInput } from "../lib/findings";

/** How a tool can end the agent's turn on its task. */
export type Stop =
  | { kind: "complete"; summary: string; verification: string; responses?: Answer[] }
  | { kind: "review"; verdict: "approve" | "request_changes"; comments: string; findings: FindingInput[] }
  | { kind: "ask"; question: string; options: { label: string; description?: string; recommended?: boolean }[] }
  | { kind: "block"; reason: string }
  | { kind: "plan_ready"; note: string }
  | { kind: "reply"; message: string }
  | { kind: "acceptance"; results: { id: string; met: boolean; evidence: string }[] }
  | { kind: "asks"; asks: { id?: string; ask: string; met: boolean; evidence: string }[] }
  /** The agent answered the message its turn was started for. */
  | { kind: "answered"; text: string };

/** What a tool did, for the run's execution metrics. */
export interface ToolMetrics { read?: boolean; redundant?: boolean; wrote?: boolean; searched?: boolean; listed?: boolean }

export interface ToolResult { text: string; ok?: boolean; image?: string; stop?: Stop; metrics?: ToolMetrics }

/**
 * File contents already in an agent's transcript: the content hash, the line ranges shown, and the transcript position of
 * the tool output that carries them. The position is what lets compaction forget a file whose output it removed.
 */
export type Shown = Map<string, { hash: string; ranges: [number, number][]; at?: number }>

export interface HireSpec { role_key?: string; title: string; name?: string; department: string; reports_to?: string; manager?: boolean; instructions?: string; reason: string }
export interface TaskSpec { title: string; description: string; acceptance_criteria: string; assignee: string; kind: TaskOut["kind"]; depends_on: string[]; requirements: string[]; files: string[]; skills: string[]; specialists: string[] }

/** What the orchestrator's tools can do to the conversation (only present for the orchestrator). */
export interface Planner {
  hire(spec: HireSpec): AgentOut;
  addTask(spec: TaskSpec): TaskOut;
  tasks(): TaskOut[];
  requirements(): Requirement[];
  addRequirements(texts: string[]): Requirement[];
  cutRequirement(id: string, reason: string): Requirement;
  /** Add to an open task's brief; a running assignee gets it before its next step. */
  amendTask(key: string, note: string): TaskOut;
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
  /**
   * Message a teammate by name, or the team chat with "team". With `wait`, resolves with the reply; otherwise the
   * reply reaches this agent before a later step.
   */
  message(to: string, text: string, wait: boolean): Promise<string>;
  /** Reply to a message by its id. */
  reply(messageId: string, text: string): string;
  /** Pin an interface or decision to the team chat; teammates working on its paths hear about it. */
  pin(key: string, text: string, paths: string[]): string;
  /** The message this turn was started to answer, when it is an answer turn. */
  answering: string | null;
  /** The running task (other than this one) that owns a path, as "T4 (Lena)", or null when nobody else does. */
  ownerOf(rel: string): string | null;
  /** Start the project's dev server in the background (or find the running one) and return where it listens. */
  devServer(): Promise<{ command: string; url: string | null; output: string }>;
  /** The read-only specialists the review and explore tools call. Only the main agent of a solo conversation has them. */
  specialists?: SpecialistPort;
}

/** The specialists a review can name. The explorer answers questions instead, through `explore`. */
export type ReviewerName = "reviewer" | "security" | "designer" | "verifier";

export interface SpecialistPort {
  /** Runs the named specialists at once, waits for all of them, and returns their findings as one message. */
  review(names: ReviewerName[], focus: string): Promise<string>;
  /** Answers one question about the project or the web, in a message under the return limit. */
  explore(question: string): Promise<string>;
}

export interface Tool<A = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  name: string;
  description: string;
  args: z.ZodType<A>;
  /** Whether a call changes nothing. Read-only calls in one model step run together; the others run one at a time. */
  readOnly?: boolean;
  /** JSON Schema sent to the model when it cannot be derived from `args` (MCP tools bring their own). */
  parameters?: Record<string, unknown>;
  run(ctx: ToolContext, args: A, callId: string): Promise<ToolResult>;
}

export const defineTool = <S extends z.ZodType>(t: { name: string; description: string; args: S; readOnly?: boolean; run(ctx: ToolContext, args: z.infer<S>, callId: string): Promise<ToolResult> }): Tool<z.infer<S>> =>
  t as unknown as Tool<z.infer<S>>;

export class Denied extends Error {}

/**
 * The strict-mode form of a JSON schema: every property required, nothing additional allowed, and a property that was
 * optional becomes nullable (which is how strict mode expresses "may be absent"). Nulls are stripped before validation.
 */
export function strictParameters(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = schema as Record<string, unknown>;
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    return {
      ...s, additionalProperties: false, required: Object.keys(props),
      properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, required.has(k) ? strictParameters(v) : { anyOf: [strictParameters(v), { type: "null" }] }])),
    };
  }
  if (s.items) return { ...s, items: strictParameters(s.items) };
  if (Array.isArray(s.anyOf)) return { ...s, anyOf: s.anyOf.map(strictParameters) };
  return s;
}

export function toFunction(t: Tool, strict = false): FunctionTool {
  const schema = t.parameters ?? (() => {
    const s = z.toJSONSchema(t.args, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
    delete s.$schema;
    return s;
  })();
  const parameters = (strict ? strictParameters(schema) : schema) as Record<string, unknown>;
  return { type: "function", name: t.name, description: t.description.slice(0, 1000), parameters, strict };
}
