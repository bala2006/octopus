/** Wire types come from the shared contract (`@octopus/shared`); components import them from here. */
import type { RunTopic } from "@octopus/shared";

export type {
  AgentBehavior, AgentIn, AgentOut, AgentStatus, AgentTools, ApprovalMode, ArtifactOut, BrowseOut, CanvasOut, CompanyOut, EdgeIn, EdgeOut,
  EdgeConfig, EdgeType, FileNode, McpServerIn, McpServerOut, MessageOut, ParsedFileOut, PendingApproval, ProviderInfo, ProviderKeyOut, RoleTemplateOut, RunBudget,
  RunDetail, RunOut, RunStatus, SessionOut, SettingsOut, SkillOut, TaskOut, TemplateOut, WorkspaceOut,
} from "@octopus/shared";

/** A WebSocket or replayed run event. `data` is loosely typed here; RunEventMap in @octopus/shared has the shapes. */
export interface RunEvent {
  type: RunTopic | "__reset";
  run_id?: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  seq?: number;
  ts?: string;
  replay?: boolean;
}
