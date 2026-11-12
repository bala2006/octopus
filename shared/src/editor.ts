/** The code workspace (IDE) contract: documents, file items, git, commands and the dev server. */
import { z } from "zod";

export interface EditorTree { files: string[]; folders: string[]; truncated: boolean }
export interface Document { path: string; content: string; revision: string; size: number }
export const SaveDocumentSchema = z.object({ path: z.string(), content: z.string().max(5_000_000), revision: z.string().nullable().optional() });
export const FolderInSchema = z.object({ path: z.string().min(1) });
export interface SearchResults { matches: { path: string; line: number; text: string }[]; searched: number; truncated: boolean }

export interface FileItem { path: string; kind: "file" | "folder"; revision: string; size: number }
export const MoveDocumentSchema = z.object({ path: z.string(), destination: z.string(), revision: z.string() });
export const FileVersionSchema = z.object({ path: z.string(), revision: z.string() });
export interface TrashResult { token: string }
export interface TrashedItem { token: string; path: string; kind: "file" | "folder"; size: number; deleted_at: number }

export interface GitFile { path: string; original_path: string | null; status: string }
export interface GitStatus { branch: string; files: GitFile[]; index_revision: string }
export interface GitDiff { patch: string }
export const GitStageSchema = z.object({ path: z.string(), staged: z.boolean() });
export const GitCommitSchema = z.object({ message: z.string().min(1).max(10_000), expected_index: z.string() });
export interface GitCommitResult { commit_sha: string; status: GitStatus }
export const LocalBranchSchema = z.object({ branch: z.string().min(1).max(200) });
export const LocalWorktreeSchema = z.object({ base_branch: z.string().min(1).max(200) });
export const LocalEnvironmentSchema = z.object({ selected: z.string().nullable().optional() });
/** Git branch and worktree state, plus Python virtual environments the agents' commands can use. */
export interface LocalEnvironment {
  repository: boolean; branch: string; branches: string[]; dirty_count: number;
  worktrees: { path: string; branch: string }[];
  environments: { id: string; label: string; path: string }[];
  selected_environment: string | null;
}
export interface WorktreeResult { workspace: { id: string; name: string }; branch: string }

export type ProcessState = "idle" | "running" | "exited";
export interface CommandStatus {
  command: string; directory: string; status: ProcessState; exit_code: number | null; output: string; truncated: boolean; timed_out: boolean;
}
export type ServerStatus = Omit<CommandStatus, "timed_out">;
export const StartCommandSchema = z.object({ command: z.string().min(1).max(4000), directory: z.string().optional(), timeout_seconds: z.number().int().min(1).max(86_400).optional() });
export const StartServerSchema = z.object({ command: z.string().min(1).max(4000), directory: z.string().optional() });
export const CommandInputSchema = z.object({ text: z.string().max(100_000) });
export interface ProjectTask { id: string; name: string; command: string; directory: string; kind: "task" | "server"; source: string }
export interface ProjectTasks { tasks: ProjectTask[]; warnings: string[] }
