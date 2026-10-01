/** Pure helpers behind the role / tools pickers on the canvas (mini window and inspector). */
import type { AgentTools, RoleTemplateOut } from "@/types";
import type { AgentData } from "@/stores/canvas";
import type { ComboOption } from "@/components/ui/combobox";
import { groupRoles } from "@/features/settings/RolesSection";

type Behavior = NonNullable<AgentData["behavior"]>;

export const roleOptions = (roles: RoleTemplateOut[]): ComboOption[] =>
  groupRoles(roles).flatMap(([cat, rs]) => rs.map((r) => ({ value: r.key, label: r.role, group: cat, hint: r.description || undefined,
    keywords: r.key })));

/** Whether the agent runs with its role's prompt (same rule as backend services/roles.py `linked`). */
export function isLinked(d: Pick<AgentData, "behavior" | "system_prompt">, roles: RoleTemplateOut[]): boolean {
  const b = (d.behavior ?? {}) as Partial<Behavior>;
  const key = b.template_key;
  if (!key) return false;
  if (b.prompt_linked === true) return true;
  if (b.prompt_linked === false) return false;
  const r = roles.find((x) => x.key === key);
  return !!r && (!(d.system_prompt ?? "").trim() || (d.system_prompt ?? "").trim() === r.system_prompt.trim());
}

/** The patch that gives an agent a role: title, prompt (linked), look and tools. Manager rights and MCP grants are kept. */
export function applyRole(d: AgentData, r: RoleTemplateOut): Partial<AgentData> {
  const cur = (d.tools ?? {}) as AgentTools;
  return {
    role: r.role, description: r.description, avatar: r.avatar, color: r.color, system_prompt: r.system_prompt,
    tools: { ...r.tools, mcp_servers: cur.mcp_servers ?? [], manage_team: !!(r.tools.manage_team || d.is_manager) } as AgentTools,
    behavior: { ...(d.behavior ?? {}), template_key: r.key, prompt_linked: true } as Behavior,
  };
}

const T = (on: (keyof AgentTools)[]): Partial<AgentTools> => Object.fromEntries(
  (["file_read", "list_files", "file_write", "terminal", "web_search", "browser", "calculator", "ask_user", "send_message"] as const)
    .map((k) => [k, on.includes(k)])) as Partial<AgentTools>;

/** Tool presets: one choice instead of ten switches. Manage team and MCP grants are separate. */
export const TOOL_PRESETS: { value: string; label: string; hint: string; tools: Partial<AgentTools> }[] = [
  { value: "builder", label: "Builder", hint: "Read, write, run code, browser, messaging", tools: T(["file_read", "list_files", "file_write", "terminal", "browser", "calculator", "send_message"]) },
  { value: "reviewer", label: "Reviewer / tester", hint: "Read, run code and tests, browser, messaging, no file edits", tools: T(["file_read", "list_files", "terminal", "browser", "calculator", "send_message"]) },
  { value: "researcher", label: "Researcher", hint: "Web search, browser, read, write notes, messaging", tools: T(["file_read", "list_files", "file_write", "web_search", "browser", "calculator", "send_message"]) },
  { value: "planner", label: "Planner / writer", hint: "Read and write documents, messaging", tools: T(["file_read", "list_files", "file_write", "calculator", "send_message"]) },
  { value: "readonly", label: "Read-only", hint: "Read files and talk, nothing else", tools: T(["file_read", "list_files", "send_message"]) },
];

export function presetOf(tools: AgentTools | undefined, role?: RoleTemplateOut): string {
  const t = (tools ?? {}) as Record<string, unknown>;
  const same = (p: Partial<AgentTools>) => Object.entries(p).every(([k, v]) => !!t[k] === !!v);
  if (role && same(Object.fromEntries(Object.entries(role.tools).filter(([k]) => k !== "mcp_servers" && k !== "manage_team")) as Partial<AgentTools>)) return "role";
  return TOOL_PRESETS.find((p) => same(p.tools))?.value ?? "custom";
}

export const EFFORT_OPTIONS = [
  { value: "default", label: "Auto" }, { value: "none", label: "None" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" },
  { value: "high", label: "High" }, { value: "xhigh", label: "X-High" }, { value: "max", label: "Max" },
];
