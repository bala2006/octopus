/**
 * Domain model shared by the server and the web app. Request bodies are zod schemas (validated by the server at the
 * trust boundary); responses are plain interfaces. Field names are snake_case because they are the wire format.
 */
import { z } from "zod";

export const EFFORTS = ["default", "none", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export const EDGE_TYPES = ["delegate", "review", "debate", "report", "consult"] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
export type ApprovalMode = "ask" | "auto";
export type RunStatus = "queued" | "running" | "paused" | "awaiting_user" | "completed" | "incomplete" | "failed" | "cancelled";
export type AgentStatus =
  | "idle" | "thinking" | "speaking" | "writing" | "reading" | "running" | "tool" | "waiting" | "awaiting_approval" | "error" | "done";
export const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "incomplete", "failed", "cancelled"];

// ── Agents and the org chart ─────────────────────────────────────────────────────────────────────────────────────────

export const AgentToolsSchema = z.object({
  file_read: z.boolean().optional(),
  list_files: z.boolean().optional(),
  file_write: z.boolean().optional(),
  terminal: z.boolean().optional(),
  web_search: z.boolean().optional(),
  browser: z.boolean().optional(),
  calculator: z.boolean().optional(),
  ask_user: z.boolean().optional(),
  send_message: z.boolean().optional(),
  manage_team: z.boolean().optional(),
  mcp_servers: z.array(z.string()).optional(),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;

export const AgentBehaviorSchema = z.object({
  reasoning_effort: z.enum(EFFORTS).optional(),
  template_key: z.string().optional(),
  prompt_linked: z.boolean().nullable().optional(),
  skills: z.array(z.string()).optional(),
  extra_instructions: z.string().optional(),
  creativity: z.number().optional(),
  strictness: z.number().optional(),
  assertiveness: z.number().optional(),
  debate_style: z.enum(["agreeable", "balanced", "devils_advocate"]).optional(),
  max_autonomous_turns: z.number().int().optional(),
});
export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

export const AgentInSchema = z.object({
  id: z.string().nullable().optional(),
  name: z.string().min(1).max(80),
  role: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  system_prompt: z.string().max(40_000).optional(),
  department: z.string().max(80).optional(),
  is_entry: z.boolean().optional(),
  is_manager: z.boolean().optional(),
  reports_to: z.string().nullable().optional(),
  avatar: z.string().optional(),
  color: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  position_x: z.number().optional(),
  position_y: z.number().optional(),
  active: z.boolean().optional(),
  tools: AgentToolsSchema.optional(),
  behavior: AgentBehaviorSchema.optional(),
  created_by: z.string().nullable().optional(),
});
export type AgentIn = z.infer<typeof AgentInSchema>;

export interface AgentOut {
  id: string;
  company_id: string;
  name: string;
  role: string;
  description: string;
  system_prompt: string;
  department: string;
  is_entry: boolean;
  is_manager: boolean;
  reports_to: string | null;
  avatar: string;
  color: string;
  model: string;
  provider: string;
  temperature: number;
  max_tokens: number;
  position_x: number;
  position_y: number;
  active: boolean;
  tools: AgentTools;
  behavior: AgentBehavior;
  created_by: string | null;
}

export const EdgeConfigSchema = z.object({
  handoff_instructions: z.string().optional(),
  condition: z.string().optional(),
  max_revisions: z.number().int().optional(),
  max_rounds: z.number().int().optional(),
});
export type EdgeConfig = z.infer<typeof EdgeConfigSchema>;

export const EdgeInSchema = z.object({
  id: z.string().nullable().optional(),
  source_agent_id: z.string(),
  target_agent_id: z.string(),
  type: z.enum(EDGE_TYPES).optional(),
  label: z.string().optional(),
  bidirectional: z.boolean().optional(),
  config: EdgeConfigSchema.optional(),
});
export type EdgeIn = z.infer<typeof EdgeInSchema>;

export interface EdgeOut {
  id: string;
  company_id: string;
  source_agent_id: string;
  target_agent_id: string;
  type: EdgeType;
  label: string;
  bidirectional: boolean;
  config: EdgeConfig;
}

export const DepartmentMetaSchema = z.object({ color: z.string().optional(), description: z.string().optional() });
export type DepartmentMeta = z.infer<typeof DepartmentMetaSchema>;
/** A department as stored and returned: always has a colour. */
export interface DepartmentInfo { color: string; description?: string }
export interface DepartmentSummary { name: string; color: string; manager: string | null; members: string[] }

export interface CompanyOut { id: string; name: string; description: string; agent_count: number; created_at: string; updated_at: string }
export interface CanvasOut {
  company: CompanyOut;
  agents: AgentOut[];
  edges: EdgeOut[];
  departments: Record<string, DepartmentInfo>;
  viewport: Record<string, number> | null;
  revision: number;
}

export const CanvasStateSchema = z.object({
  agents: z.array(AgentInSchema).max(200),
  edges: z.array(EdgeInSchema).max(1000),
  departments: z.record(z.string(), DepartmentMetaSchema).nullable().optional(),
  viewport: z.record(z.string(), z.number()).nullable().optional(),
  revision: z.number().int().nullable().optional(),
});
export type CanvasState = z.infer<typeof CanvasStateSchema>;

export const CanvasExportSchema = z.object({
  format: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  agents: z.array(AgentInSchema).max(200),
  edges: z.array(EdgeInSchema).max(1000),
  departments: z.record(z.string(), DepartmentMetaSchema).optional(),
});
export type CanvasExport = z.infer<typeof CanvasExportSchema>;

export const CompanyInSchema = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).optional() });
export const CompanyPatchSchema = CompanyInSchema.partial();
export const InstantiateTemplateSchema = z.object({ template_key: z.string(), name: z.string().nullable().optional(), goal: z.string().nullable().optional() });
export const GenerateCompanySchema = z.object({ prompt: z.string().min(1).max(8000), max_agents: z.number().int().min(1).max(40).optional(), model: z.string().nullable().optional() });
export interface GenerateCompanyOut { spec: CanvasExport; departments: DepartmentSummary[]; source: "ai"; warning?: string }

export const UserTemplateInSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  company_id: z.string().nullable().optional(),
  spec: CanvasExportSchema.nullable().optional(),
});
export interface TemplateOut {
  key: string; name: string; description: string; agent_count: number; edge_count: number;
  departments: DepartmentSummary[]; source: "builtin" | "user"; workflow: boolean; updated_at: string | null;
}

export const RoleInSchema = z.object({
  role: z.string().min(1),
  system_prompt: z.string().min(1),
  description: z.string().optional(),
  default_name: z.string().optional(),
  category: z.string().optional(),
  color: z.string().optional(),
  avatar: z.string().optional(),
  tools: AgentToolsSchema.nullable().optional(),
});
export interface RoleTemplateOut {
  key: string; role: string; default_name: string; category: string; color: string; avatar: string;
  description: string; system_prompt: string; tools: AgentTools; source: "builtin" | "modified" | "custom";
}

export const SkillInSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  description: z.string().min(1),
  body: z.string().min(1).max(60_000),
  roles: z.array(z.string()).optional(),
  phases: z.array(z.string()).optional(),
});
export interface SkillOut { name: string; description: string; body: string; roles: string[]; phases: string[]; source: "builtin" | "modified" | "custom" }

export const MemoryInSchema = z.object({ key: z.string().min(1).max(200), value: z.string().max(20_000) });
export interface MemoryOut { id: string; agent_id: string; key: string; value: string; updated_at: string }

// ── Projects (workspaces) ────────────────────────────────────────────────────────────────────────────────────────────

export const WorkspaceInSchema = z.object({ path: z.string().min(1), name: z.string().nullable().optional() });
export const WorkspacePatchSchema = z.object({ name: z.string().min(1).max(120).nullable().optional() });
export interface WorkspaceOut { id: string; name: string; path: string; created_at: string; last_opened_at: string; exists: boolean; existing_project: boolean }
export interface DirEntryOut { name: string; path: string; is_git: boolean; is_project: boolean }
export interface BrowseOut { path: string | null; parent: string | null; entries: DirEntryOut[]; roots: string[] }
export interface NativeDialogOut { available: boolean; method?: string; reason?: string }
export interface NativePickOut { cancelled: boolean; path?: string | null }
export interface FileNode { path: string; size: number; area: "project" | "work"; modified?: boolean; generated?: boolean }
export interface ProjectTreeOut { root: string; name: string; files: FileNode[]; truncated: boolean }
export interface FileContentOut { path: string; content: string; size: number }
export interface ParsedFileOut { filename: string; text: string; chars: number; truncated: boolean; kind: "text" | "image"; mime?: string; data?: string }

// ── Conversations (runs) ─────────────────────────────────────────────────────────────────────────────────────────────

export const RunBudgetSchema = z.object({
  max_concurrency: z.number().int().min(1).max(8).optional(),
  max_agents: z.number().int().min(1).max(60).optional(),
  max_revisions: z.number().int().min(0).max(5).optional(),
  reasoning_effort: z.enum(EFFORTS).optional(),
  /** Azure deployment for every agent in this conversation; null keeps each agent's own model. */
  model: z.string().nullable().optional(),
  /** Independent review of every change (on by default). */
  review: z.boolean().optional(),
  /** Run the project's tests after changes (on by default when the project has tests). */
  verify: z.boolean().optional(),
});
export type RunBudget = z.infer<typeof RunBudgetSchema>;
export const DEFAULT_BUDGET: Required<Omit<RunBudget, "model">> & { model: string | null } = {
  max_concurrency: 3, max_agents: 16,
  max_revisions: 2, reasoning_effort: "default", model: null, review: true, verify: true,
};

export const AttachmentSchema = z.object({
  filename: z.string().max(255),
  text: z.string().max(400_000).optional(),
  kind: z.enum(["text", "image"]).optional(),
  mime: z.string().optional(),
  data: z.string().max(14_000_000).optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const RunCreateSchema = z.object({
  company_id: z.string(),
  goal: z.string().min(1).max(100_000),
  session_id: z.string().nullable().optional(),
  mode: z.enum(["autonomous", "step", "supervised"]).optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
  budget: RunBudgetSchema.optional(),
  client_request_id: z.string().nullable().optional(),
});
export type RunCreate = z.infer<typeof RunCreateSchema>;

export const FollowUpSchema = z.object({
  content: z.string().min(1).max(100_000),
  to_agent_id: z.string().nullable().optional(),
  attachments: z.array(AttachmentSchema).max(20).optional(),
  client_request_id: z.string().nullable().optional(),
});
export type FollowUp = z.infer<typeof FollowUpSchema>;

export const ApprovalInSchema = z.object({
  approval_id: z.string(),
  approved: z.boolean(),
  scope: z.enum(["once", "always"]).optional(),
  reason: z.string().optional(),
});
export type ApprovalIn = z.infer<typeof ApprovalInSchema>;
export const RUN_ACTIONS = ["pause", "resume", "step", "stop"] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];

export interface RunOutcome { tasks_total: number; tasks_done: number; tasks_open: number; tasks_blocked: number; files: number; errors: number; final_report: boolean }
export interface RunOut {
  id: string; company_id: string; session_id: string | null; goal: string; status: RunStatus; mode: string;
  budget: RunBudget; permission_level: ApprovalMode; summary: string; halt_reason: string;
  tokens_used: number; cost_usd: number; turns: number; outcome: RunOutcome | null;
  created_at: string; started_at: string | null; ended_at: string | null;
}
export interface RunDetail extends RunOut {
  report_md: string;
  /** The team when the conversation started, plus everyone hired since. */
  snapshot: { agents: AgentOut[]; edges: EdgeOut[]; departments: Record<string, DepartmentInfo> };
  state: Record<string, unknown>;
}

export type TaskStatus = "todo" | "in_progress" | "review" | "waiting" | "done" | "blocked" | "cancelled";
export type TaskKind = "build" | "docs" | "research" | "review" | "verify" | "fix" | "answer";
export interface TaskOut {
  id: string; run_id: string; key: string; title: string; description: string; acceptance_criteria: string;
  assignee_agent_id: string | null; status: TaskStatus; kind: TaskKind; depends_on: string[]; result: string;
  created_by: string | null; attempts: number; updated_at: string;
}

export type MessageType =
  | "chat" | "task" | "status_update" | "review_request" | "review_result" | "final_report" | "question" | "answer"
  | "artifact_created" | "decision" | "consult";
export interface MessageOut {
  id: string; run_id: string | null; session_id: string | null; edge_id: string | null;
  from_agent_id: string | null; to_agent_id: string | null; sender: "user" | "agent" | "system";
  type: MessageType | string; content: string; meta: Record<string, unknown>; turn_no: number; created_at: string;
}

export interface ArtifactOut {
  id: string; run_id: string; path: string; version: number; author_agent_id: string | null; change_note: string;
  deleted: boolean; size: number; created_at: string;
}
export interface ArtifactContentOut extends ArtifactOut { content: string }
export const RevertInSchema = z.object({ path: z.string(), to_version: z.number().int().min(0).optional() });

export interface PendingApproval {
  id: string; agent_id: string; kind: "write_file" | "run_code" | "mcp_call" | "delete_file" | "move_file" | string;
  summary: string; preview: string; risk: "medium" | "high"; level?: ApprovalMode;
  details: { path?: string; old?: string; new?: string; note?: string; command?: string; cwd?: string; server?: string; tool?: string; arguments?: unknown; summary?: string; key?: string };
}

// ── Direct chats ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const SessionInSchema = z.object({
  company_id: z.string(),
  agent_id: z.string().nullable().optional(),
  mode: z.enum(["direct", "company"]).optional(),
  title: z.string().max(200).optional(),
});
export const SessionPatchSchema = z.object({ title: z.string().min(1).max(200) });
export interface SessionOut { id: string; company_id: string; agent_id: string | null; mode: string; title: string; created_at: string }

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ProviderOptionsSchema = z.object({
  auth: z.enum(["key", "entra"]).optional(),
  deployments: z.array(z.string()).optional(),
  deployment_type: z.enum(["global", "data_zone", "regional"]).optional(),
  pricing: z.record(z.string(), z.number()).optional(),
});
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;
export const ProviderKeyInSchema = z.object({
  provider: z.literal("azure"),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  options: ProviderOptionsSchema.optional(),
});
export interface ProviderKeyOut { provider: string; base_url: string; masked_key: string; options: ProviderOptions; updated_at: string }
export interface ProviderInfo { provider: string; label: string; configured: boolean; needs_key: boolean; needs_base: boolean; models: string[] }
export interface SettingsOut {
  approval_mode: ApprovalMode; default_provider: string; default_model: string; single_user_mode: boolean;
  providers: ProviderInfo[]; keys: ProviderKeyOut[];
}
export const ApprovalModeInSchema = z.object({ approval_mode: z.enum(["ask", "auto"]) });
export const TestProviderInSchema = z.object({ provider: z.string(), model: z.string() });
export interface TestResultOut { ok: boolean; detail: string; latency_ms: number }
export interface FxRateOut { currency: string; rate: number; base: string; date?: string; source?: string; stale: boolean }
export interface BrowserStatusOut { enabled: boolean; status: string; browser?: string; package?: string; node: boolean; verified: boolean; error?: string; tools: string[] }

export const McpServerInSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "letters, digits, _ and - only"),
  transport: z.enum(["stdio", "http"]).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});
export type McpServerIn = z.infer<typeof McpServerInSchema>;
export interface McpToolOut { name: string; description?: string; input_schema?: Record<string, unknown> }
export interface McpServerOut {
  id: string; name: string; transport: string; command: string; args: string[]; url: string; env_keys: string[];
  enabled: boolean; tools: McpToolOut[]; last_error: string; updated_at: string;
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActivityOut {
  days: { date: string; tokens: number }[]; lifetime_tokens: number; peak_tokens: number;
  active_days: number; current_streak: number; longest_streak: number; longest_task_seconds: number;
  most_used_reasoning: string | null; reasoning_percent: number; projects: { id: string; name: string; tokens: number }[];
  tools: { name: string; count: number }[]; unavailable_projects: number;
}
