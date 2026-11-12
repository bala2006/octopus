/**
 * The org chart: building agents from roles, wiring channels (manager ↔ report) and laying cards out as a tree.
 * Used by templates, AI-designed teams and live hiring, so every team looks and connects the same way.
 */
import type { AgentOut, DepartmentInfo, DepartmentMeta, DepartmentSummary, EdgeOut, RoleTemplateOut } from "@octopus/shared";
import { config } from "../config";
import { newId } from "../lib/util";

export const CARD_W = 260;
export const CARD_H = 150;
const GAP_X = 40;
const GAP_Y = 210;
const COLORS = ["#D97756", "#66839A", "#6B8440", "#C9A04A", "#8E7AA8", "#5E9C94", "#C0655A", "#8A7F6E", "#B58D5E", "#7B8FB8", "#A36F8C", "#7E9B6A"];
const NAMES = ["Ava", "Priya", "Marcus", "Lena", "Diego", "Sam", "Iris", "Noah", "Kai", "Mei", "Omar", "Ruth", "Theo", "Zoe", "Alex", "Nina",
  "Ravi", "Elena", "Jonas", "Amara", "Felix", "Hana", "Leo", "Maya", "Ivan", "Sofia", "Tariq", "Yara", "Ben", "Clara", "Dev", "Ines"];

export function departmentColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** A first name nobody in the team has yet, preferring the role's default. */
export function freshName(taken: string[], preferred?: string): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  if (preferred && !used.has(preferred.toLowerCase())) return preferred;
  return NAMES.find((n) => !used.has(n.toLowerCase())) ?? `${preferred ?? "Agent"} ${taken.length + 1}`;
}

export function agentFromRole(companyId: string, role: RoleTemplateOut, o: { name: string; department: string; manager?: boolean; entry?: boolean; reports_to?: string | null; created_by?: string | null; instructions?: string; title?: string }): AgentOut {
  return {
    id: newId(), company_id: companyId, name: o.name, role: o.title || role.role, description: role.description,
    system_prompt: o.instructions ? `${role.system_prompt}\n\n${o.instructions}` : role.system_prompt,
    department: o.department, is_entry: !!o.entry, is_manager: !!o.manager || !!o.entry, reports_to: o.reports_to ?? null,
    avatar: role.avatar, color: role.color, model: config.defaultModel, provider: "azure", temperature: 0.4, max_tokens: 32_000,
    position_x: 0, position_y: 0, active: true,
    tools: { ...role.tools, manage_team: !!(role.tools.manage_team || o.manager || o.entry) },
    behavior: { template_key: role.key, prompt_linked: !o.instructions, reasoning_effort: "default" },
    created_by: o.created_by ?? null,
  };
}

export function edge(companyId: string, from: string, to: string, type: EdgeOut["type"], label: string): EdgeOut {
  return { id: newId(), company_id: companyId, source_agent_id: from, target_agent_id: to, type, label, bidirectional: false, config: {} };
}

/** delegate (manager → report) and report (report → manager) channels for everyone with a manager. */
export function wire(agents: AgentOut[], existing: EdgeOut[] = []): EdgeOut[] {
  const have = new Set(existing.map((e) => `${e.source_agent_id}>${e.target_agent_id}>${e.type}`));
  const out: EdgeOut[] = [];
  const add = (e: EdgeOut) => { const k = `${e.source_agent_id}>${e.target_agent_id}>${e.type}`; if (!have.has(k)) { have.add(k); out.push(e); } };
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const a of agents) {
    const m = a.reports_to ? byId.get(a.reports_to) : undefined;
    if (!m) continue;
    add(edge(a.company_id, m.id, a.id, "delegate", `${a.department || "Team"} tasks`));
    add(edge(a.company_id, a.id, m.id, "report", "Status"));
  }
  return out;
}

/** Tidy tree layout: each manager centred above the people who report to them. Mutates positions. */
export function layoutTree(agents: AgentOut[]): AgentOut[] {
  const ids = new Set(agents.map((a) => a.id));
  const kids = new Map<string, AgentOut[]>();
  const roots: AgentOut[] = [];
  for (const a of agents) {
    if (a.reports_to && ids.has(a.reports_to) && a.reports_to !== a.id) kids.set(a.reports_to, [...(kids.get(a.reports_to) ?? []), a]);
    else roots.push(a);
  }
  const width = (a: AgentOut, seen = new Set<string>()): number => {
    if (seen.has(a.id)) return CARD_W;
    seen.add(a.id);
    const ch = kids.get(a.id) ?? [];
    return Math.max(CARD_W, ch.reduce((w, c) => w + width(c, seen), 0) + GAP_X * Math.max(0, ch.length - 1));
  };
  const place = (a: AgentOut, left: number, depth: number, seen = new Set<string>()) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    const w = width(a);
    a.position_x = Math.round(left + w / 2 - CARD_W / 2);
    a.position_y = depth * GAP_Y;
    let x = left;
    for (const c of kids.get(a.id) ?? []) { place(c, x, depth + 1, seen); x += width(c) + GAP_X; }
  };
  let left = 0;
  for (const r of roots) { place(r, left, 0); left += width(r) + GAP_X * 2; }
  return agents;
}

/** Where a new hire goes: in the row under their manager, right of their colleagues, clear of every other card. */
export function placeHire(agents: AgentOut[], hire: AgentOut) {
  const manager = agents.find((a) => a.id === hire.reports_to);
  const y = manager ? manager.position_y + GAP_Y : Math.max(0, ...agents.map((a) => a.position_y)) + GAP_Y;
  const row = agents.filter((a) => Math.abs(a.position_y - y) < CARD_H);
  let x = row.length ? Math.max(...row.map((a) => a.position_x)) + CARD_W + GAP_X : manager?.position_x ?? 0;
  if (!row.length && manager) x = manager.position_x;
  while (agents.some((a) => Math.abs(a.position_x - x) < CARD_W + GAP_X / 2 && Math.abs(a.position_y - y) < CARD_H)) x += CARD_W + GAP_X;
  hire.position_x = x;
  hire.position_y = y;
}

/** Every department the agents belong to, keeping known colours and giving new ones a colour. */
export function departmentsOf(agents: { department?: string }[], existing: Record<string, DepartmentMeta> = {}): Record<string, DepartmentInfo> {
  const out: Record<string, DepartmentInfo> = {};
  for (const [name, d] of Object.entries(existing)) out[name] = { color: d.color ?? departmentColor(name), description: d.description ?? "" };
  for (const a of agents) if (a.department && !out[a.department]) out[a.department] = { color: departmentColor(a.department), description: "" };
  return out;
}

export function departmentSummaries(agents: { name: string; department?: string; is_manager?: boolean }[], meta: Record<string, DepartmentMeta> = {}): DepartmentSummary[] {
  const by = new Map<string, DepartmentSummary>();
  for (const a of agents) {
    const d = a.department || "Team";
    const s = by.get(d) ?? { name: d, color: meta[d]?.color ?? departmentColor(d), manager: null, members: [] };
    if (a.is_manager && !s.manager) s.manager = a.name; else s.members.push(a.name);
    by.set(d, s);
  }
  return [...by.values()];
}
