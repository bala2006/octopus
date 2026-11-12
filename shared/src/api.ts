/**
 * Every JSON REST route, typed once. The server registers handlers against this map and the web client calls through
 * it, so a change to a path, body or response is a compile error on both sides. Binary and streaming responses
 * (zips, previews, report downloads, uploads) are plain URLs and are not listed here.
 */
import type { z } from "zod";
import type * as D from "./domain.js";
import type * as E from "./editor.js";

type R<Res, Body = undefined, Query = undefined> = { res: Res; body: Body; query: Query };
type In<S extends z.ZodType> = z.input<S>;
type Ok = { ok: boolean };

export interface ApiRoutes {
  "/api/health": { GET: R<{ ok: boolean; app: string; live_runs: number }> };
  "/api/v1/activity": { GET: R<D.ActivityOut, undefined, { tz?: string }> };

  // Projects and folders
  "/api/v1/fs/browse": { GET: R<D.BrowseOut, undefined, { path?: string | null; show_hidden?: boolean }> };
  "/api/v1/fs/native": { GET: R<D.NativeDialogOut> };
  "/api/v1/fs/native/pick": { POST: R<D.NativePickOut> };
  "/api/v1/workspaces": { GET: R<D.WorkspaceOut[]>; POST: R<D.WorkspaceOut, In<typeof D.WorkspaceInSchema>> };
  "/api/v1/workspaces/{workspace_id}": {
    GET: R<D.WorkspaceOut>; PATCH: R<D.WorkspaceOut, In<typeof D.WorkspacePatchSchema>>; DELETE: R<Ok>;
  };

  // Settings and catalog
  "/api/v1/settings": { GET: R<D.SettingsOut> };
  "/api/v1/settings/approval-mode": { PUT: R<{ approval_mode: D.ApprovalMode }, In<typeof D.ApprovalModeInSchema>> };
  "/api/v1/settings/providers": { PUT: R<D.ProviderKeyOut, In<typeof D.ProviderKeyInSchema>> };
  "/api/v1/settings/providers/test": { POST: R<D.TestResultOut, In<typeof D.TestProviderInSchema>> };
  "/api/v1/settings/providers/{provider}": { DELETE: R<Ok> };
  "/api/v1/settings/fx": { GET: R<D.FxRateOut, undefined, { currency?: string }> };
  "/api/v1/settings/browser": { GET: R<D.BrowserStatusOut> };
  "/api/v1/settings/browser/test": { POST: R<D.TestResultOut> };
  "/api/v1/mcp-servers": { GET: R<D.McpServerOut[]>; POST: R<D.McpServerOut, In<typeof D.McpServerInSchema>> };
  "/api/v1/mcp-servers/{server_id}": { PUT: R<D.McpServerOut, In<typeof D.McpServerInSchema>>; DELETE: R<Ok> };
  "/api/v1/mcp-servers/{server_id}/refresh": { POST: R<D.McpServerOut> };
  "/api/v1/templates": { GET: R<D.TemplateOut[]>; POST: R<D.TemplateOut, In<typeof D.UserTemplateInSchema>> };
  "/api/v1/templates/roles": { GET: R<D.RoleTemplateOut[]> };
  "/api/v1/templates/{key}": { PATCH: R<D.TemplateOut, In<typeof D.UserTemplateInSchema>>; DELETE: R<Ok> };
  "/api/v1/templates/{key}/spec": { GET: R<D.CanvasExport> };
  "/api/v1/roles": { GET: R<D.RoleTemplateOut[]>; POST: R<D.RoleTemplateOut, In<typeof D.RoleInSchema>> };
  "/api/v1/roles/{key}": { PUT: R<D.RoleTemplateOut, In<typeof D.RoleInSchema>>; DELETE: R<Ok> };
  "/api/v1/roles/restore-defaults": { POST: R<Ok> };
  "/api/v1/skills": { GET: R<D.SkillOut[]>; POST: R<D.SkillOut, In<typeof D.SkillInSchema>> };
  "/api/v1/skills/{name}": { PUT: R<D.SkillOut, In<typeof D.SkillInSchema>>; DELETE: R<Ok> };
  "/api/v1/skills/restore-defaults": { POST: R<Ok> };

  // Companies (the org chart on the canvas)
  "/api/v1/w/{workspace_id}/companies": { GET: R<D.CompanyOut[]>; POST: R<D.CanvasOut, In<typeof D.CompanyInSchema>> };
  "/api/v1/w/{workspace_id}/companies/from-template": { POST: R<D.CanvasOut, In<typeof D.InstantiateTemplateSchema>> };
  "/api/v1/w/{workspace_id}/companies/generate": { POST: R<D.GenerateCompanyOut, In<typeof D.GenerateCompanySchema>> };
  "/api/v1/w/{workspace_id}/companies/import": { POST: R<D.CanvasOut, In<typeof D.CanvasExportSchema>> };
  "/api/v1/w/{workspace_id}/companies/{company_id}": {
    GET: R<D.CanvasOut>; PATCH: R<D.CompanyOut, In<typeof D.CompanyPatchSchema>>; DELETE: R<Ok>;
  };
  "/api/v1/w/{workspace_id}/companies/{company_id}/canvas": { PUT: R<D.CanvasOut, In<typeof D.CanvasStateSchema>> };
  "/api/v1/w/{workspace_id}/companies/{company_id}/export": { GET: R<D.CanvasExport> };
  "/api/v1/w/{workspace_id}/companies/{company_id}/save-template": { POST: R<D.TemplateOut, In<typeof D.UserTemplateInSchema>> };
  "/api/v1/w/{workspace_id}/agents/{agent_id}/memory": { GET: R<D.MemoryOut[]>; PUT: R<D.MemoryOut, In<typeof D.MemoryInSchema>> };
  "/api/v1/w/{workspace_id}/agents/{agent_id}/memory/{key}": { DELETE: R<Ok> };

  // Direct chats
  "/api/v1/w/{workspace_id}/sessions": { GET: R<D.SessionOut[], undefined, { company_id: string }>; POST: R<D.SessionOut, In<typeof D.SessionInSchema>> };
  "/api/v1/w/{workspace_id}/sessions/{session_id}": { PATCH: R<D.SessionOut, In<typeof D.SessionPatchSchema>>; DELETE: R<Ok> };
  "/api/v1/w/{workspace_id}/sessions/{session_id}/messages": { GET: R<D.MessageOut[], undefined, { limit?: number }> };

  // Conversations
  "/api/v1/w/{workspace_id}/runs": { GET: R<D.RunOut[], undefined, { company_id?: string | null }>; POST: R<D.RunDetail, In<typeof D.RunCreateSchema>> };
  "/api/v1/w/{workspace_id}/runs/{run_id}": { GET: R<D.RunDetail>; DELETE: R<Ok> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/control/{action}": { POST: R<D.RunOut> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/approve": { POST: R<Ok, In<typeof D.ApprovalInSchema>> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/continue": { POST: R<{ ok: boolean; message_id: string }, In<typeof D.FollowUpSchema>> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/messages": { GET: R<D.MessageOut[]> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/tasks": { GET: R<D.TaskOut[]> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/events": { GET: R<{ id: number; run_id: string; type: string; payload: unknown; created_at: string }[], undefined, { after?: number; limit?: number }> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/artifacts": { GET: R<D.ArtifactOut[], undefined, { all_versions?: boolean }> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/artifacts/file": { GET: R<D.ArtifactContentOut, undefined, { path: string; version?: number | null }> };
  "/api/v1/w/{workspace_id}/runs/{run_id}/artifacts/revert": { POST: R<{ status: "restored" | "deleted"; path: string; version: number }, In<typeof D.RevertInSchema>> };

  // Project files
  "/api/v1/w/{workspace_id}/files": { GET: R<D.FileNode[]> };
  "/api/v1/w/{workspace_id}/files/content": { GET: R<D.FileContentOut, undefined, { path: string }> };
  "/api/v1/w/{workspace_id}/tree": { GET: R<D.ProjectTreeOut> };

  // Code workspace
  "/api/v1/w/{workspace_id}/editor/tree": { GET: R<E.EditorTree> };
  "/api/v1/w/{workspace_id}/editor/document": { GET: R<E.Document, undefined, { path: string }>; PUT: R<E.Document, In<typeof E.SaveDocumentSchema>> };
  "/api/v1/w/{workspace_id}/editor/search": { GET: R<E.SearchResults, undefined, { q: string }> };
  "/api/v1/w/{workspace_id}/editor/folder": { POST: R<{ path: string }, In<typeof E.FolderInSchema>> };
  "/api/v1/w/{workspace_id}/editor/item": { GET: R<E.FileItem, undefined, { path: string }> };
  "/api/v1/w/{workspace_id}/editor/item/move": { POST: R<E.FileItem, In<typeof E.MoveDocumentSchema>> };
  "/api/v1/w/{workspace_id}/editor/item/trash": { POST: R<E.TrashResult, In<typeof E.FileVersionSchema>> };
  "/api/v1/w/{workspace_id}/editor/item/restore/{token}": { POST: R<E.FileItem> };
  "/api/v1/w/{workspace_id}/editor/items/trash": { GET: R<E.TrashedItem[]> };
  "/api/v1/w/{workspace_id}/editor/git": { GET: R<E.GitStatus> };
  "/api/v1/w/{workspace_id}/editor/git/diff": { GET: R<E.GitDiff, undefined, { path: string; staged?: boolean }> };
  "/api/v1/w/{workspace_id}/editor/git/stage": { POST: R<E.GitStatus, In<typeof E.GitStageSchema>> };
  "/api/v1/w/{workspace_id}/editor/git/commit": { POST: R<E.GitCommitResult, In<typeof E.GitCommitSchema>> };
  "/api/v1/w/{workspace_id}/editor/git/branch": { POST: R<E.LocalEnvironment, In<typeof E.LocalBranchSchema>> };
  "/api/v1/w/{workspace_id}/editor/git/worktree": { POST: R<E.WorktreeResult, In<typeof E.LocalWorktreeSchema>> };
  "/api/v1/w/{workspace_id}/editor/local-environment": { GET: R<E.LocalEnvironment>; PUT: R<E.LocalEnvironment, In<typeof E.LocalEnvironmentSchema>> };
  "/api/v1/w/{workspace_id}/editor/tasks": { GET: R<E.ProjectTasks> };
  "/api/v1/w/{workspace_id}/editor/commands/current": { GET: R<E.CommandStatus>; POST: R<E.CommandStatus, In<typeof E.StartCommandSchema>>; DELETE: R<E.CommandStatus> };
  "/api/v1/w/{workspace_id}/editor/commands/input": { POST: R<E.CommandStatus, In<typeof E.CommandInputSchema>> };
  "/api/v1/w/{workspace_id}/editor/commands/output": { DELETE: R<E.CommandStatus> };
  "/api/v1/w/{workspace_id}/editor/server": { GET: R<E.ServerStatus>; POST: R<E.ServerStatus, In<typeof E.StartServerSchema>>; DELETE: R<E.ServerStatus> };
}

export type ApiPath = Extract<keyof ApiRoutes, string>;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type MethodsOf<P extends ApiPath> = Extract<keyof ApiRoutes[P], Method>;
export type Route<P extends ApiPath, M extends MethodsOf<P>> = ApiRoutes[P][M] extends R<infer Res, infer Body, infer Query>
  ? { res: Res; body: Body; query: Query } : never;
type ParamNames<P extends string> = P extends `${string}{${infer N}}${infer Rest}` ? N | ParamNames<Rest> : never;
export type PathParams<P extends string> = [ParamNames<P>] extends [never] ? undefined : { [K in ParamNames<P>]: string };
