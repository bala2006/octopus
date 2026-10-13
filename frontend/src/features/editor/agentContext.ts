import type { PermissionLevel } from "@/types";

export type AgentMode = "agent" | "plan" | "ask";
export interface CodeContext {
  path: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  dirty?: boolean;
}

/** Keep editor context explicit, bounded, and distinct from the user's instruction. */
export function contextGoal(
  instruction: string,
  contexts: CodeContext[],
): string {
  let result = instruction.trim();
  if (contexts.length)
    result +=
      "\n\nUse the attached code as context. Unsaved snapshots are not changes on disk.";
  for (const c of contexts.slice(0, 8)) {
    const heading = `\n\n--- Editor context: ${c.path}${c.startLine ? `:${c.startLine}-${c.endLine ?? c.startLine}` : ""} (${c.dirty ? "unsaved editor snapshot" : "saved file snapshot"}) ---\n`;
    const remaining = 19500 - result.length - heading.length - 90;
    if (remaining < 0) break;
    const text = (c.content ?? "").slice(0, Math.min(6000, remaining));
    result +=
      heading +
      text +
      ((c.content?.length ?? 0) > text.length
        ? "\n[Context truncated. Read the project file for additional saved content.]"
        : "");
  }
  return result;
}

export function modePermission(
  mode: AgentMode,
  project: PermissionLevel,
): PermissionLevel {
  if (project === "read_only" || mode === "ask") return "read_only";
  if (project === "plan" || mode === "plan") return "plan";
  return project;
}
