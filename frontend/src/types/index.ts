import type { components } from "./api.gen";

type S = components["schemas"];
export type AgentOut = S["AgentOut"];
export type AgentIn = S["AgentIn"];
export type AgentTools = S["AgentTools"];
export type AgentBehavior = S["AgentBehavior"];
export type EdgeOut = S["EdgeOut"];
export type EdgeIn = S["EdgeIn"];
export type EdgeConfig = S["EdgeConfig"];
export type CanvasOut = S["CanvasOut"];
export type CompanyOut = S["CompanyOut"];
export type TemplateOut = S["TemplateOut"];
export type RoleTemplateOut = S["RoleTemplateOut"];
export type SessionOut = S["SessionOut"];
export type MessageOut = S["MessageOut"];
export type RunOut = S["RunOut"];
export type RunDetail = S["RunDetail"];
export type RunBudget = S["RunBudget"];
export type RunCreate = S["RunCreate"];
export type RunEventOut = S["RunEventOut"];
export type TaskOut = S["TaskOut"];
export type ArtifactOut = S["ArtifactOut"];
export type ArtifactContentOut = S["ArtifactContentOut"];
export type SettingsOut = S["SettingsOut"];
export type ProviderInfo = S["ProviderInfo"];
export type ProviderKeyIn = S["ProviderKeyIn"];
export type ProviderKeyOut = S["ProviderKeyOut"];
export type McpServerOut = S["McpServerOut"];
export type McpServerIn = S["McpServerIn"];
export type WorkspaceOut = S["WorkspaceOut"];
export type BrowseOut = S["BrowseOut"];
export type FileNode = S["FileNode"];
export type MemoryOut = S["MemoryOut"];
export type ParsedFileOut = S["ParsedFileOut"];

export type EdgeType = EdgeOut["type"];
export type PermissionLevel = "read_only" | "plan" | "ask" | "danger";
export type AgentPermission = "inherit" | PermissionLevel;
export type RunStatus = "queued" | "running" | "paused" | "awaiting_user" | "completed" | "failed" | "cancelled";
export type AgentStatus =
  | "idle" | "thinking" | "speaking" | "writing" | "reading" | "running" | "tool" | "waiting" | "awaiting_approval" | "error" | "done";

/** A WebSocket / replayed run event. `seq` is present for persisted events. */
export interface RunEvent {
  type: string;
  run_id?: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  seq?: number;
  ts?: string;
  replay?: boolean;
}

export interface PendingApproval {
  id: string;
  agent_id: string;
  kind: "write_file" | "run_code" | "mcp_call" | "finish" | string;
  summary: string;
  preview: string;
  details: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  level?: PermissionLevel;
}
