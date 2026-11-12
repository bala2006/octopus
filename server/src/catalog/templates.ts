/**
 * Team templates. "Self-organizing" (the default) starts with only the orchestrator, which hires as the work requires;
 * the others start from a typical company shape that the orchestrator still extends when needed.
 */
import type { AgentOut, CanvasExport, EdgeOut, TemplateOut } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { agentFromRole, departmentColor, departmentsOf, departmentSummaries, freshName, layoutTree, wire } from "../engine/org";
import { UserError } from "../lib/util";
import { effectiveRoles } from "./roles";

interface Dept { name: string; lead: string; members?: string[] }
interface Template { key: string; name: string; description: string; head: string; departments: Dept[] }

const ENG = "Engineering", PD = "Product & Design", QO = "Quality & Ops";

export const BUILTIN_TEMPLATES: Template[] = [
  { key: "adaptive", name: "Self-organizing", description: "Octopus alone at first; it hires exactly the specialists each request needs.", head: "orchestrator", departments: [] },
  { key: "solo_engineer", name: "Solo Engineer", description: "Octopus and one full-stack developer, with automatic review.", head: "orchestrator",
    departments: [{ name: ENG, lead: "developer" }] },
  { key: "small_dev_team", name: "Small Dev Team", description: "A tech lead with frontend and backend developers.", head: "orchestrator",
    departments: [{ name: ENG, lead: "techlead", members: ["frontend", "backend"] }] },
  { key: "software_startup", name: "Software Startup", description: "Product, design, engineering, QA and DevOps under a CEO.", head: "ceo",
    departments: [{ name: PD, lead: "pm", members: ["designer"] }, { name: ENG, lead: "architect", members: ["frontend", "backend"] }, { name: QO, lead: "qa", members: ["devops"] }] },
  { key: "web_app_studio", name: "Web App Studio", description: "Designer-led web product team with a reviewer and QA.", head: "orchestrator",
    departments: [{ name: PD, lead: "designer" }, { name: ENG, lead: "techlead", members: ["frontend", "backend"] }, { name: QO, lead: "qa" }] },
  { key: "mobile_app_team", name: "Mobile App Team", description: "Mobile and backend developers with design and QA.", head: "orchestrator",
    departments: [{ name: PD, lead: "designer" }, { name: ENG, lead: "techlead", members: ["mobile", "backend"] }, { name: QO, lead: "qa" }] },
  { key: "saas_launch", name: "SaaS Launch", description: "Build the product and the launch: engineering, docs and marketing.", head: "ceo",
    departments: [{ name: PD, lead: "pm", members: ["designer", "writer"] }, { name: ENG, lead: "techlead", members: ["frontend", "backend"] }, { name: "Growth", lead: "marketer" }, { name: QO, lead: "qa", members: ["devops"] }] },
  { key: "data_science_team", name: "Data Science Team", description: "Data engineering and research with review.", head: "orchestrator",
    departments: [{ name: "Data", lead: "data", members: ["researcher"] }, { name: ENG, lead: "techlead" }] },
  { key: "security_audit", name: "Security Audit", description: "Security review and fixes with an independent reviewer.", head: "orchestrator",
    departments: [{ name: "Security", lead: "security", members: ["developer"] }, { name: QO, lead: "techlead" }] },
  { key: "content_studio", name: "Content Studio", description: "Research, writing, design and marketing.", head: "orchestrator",
    departments: [{ name: "Content", lead: "writer", members: ["researcher"] }, { name: "Growth", lead: "marketer", members: ["designer"] }] },
  { key: "research_lab", name: "Research Lab", description: "Researchers and an engineer to prototype findings.", head: "orchestrator",
    departments: [{ name: "Research", lead: "researcher", members: ["data"] }, { name: ENG, lead: "developer" }] },
  { key: "full_company", name: "Full Company", description: "Every department, ready for large products.", head: "ceo",
    departments: [{ name: PD, lead: "pm", members: ["designer", "writer"] }, { name: ENG, lead: "architect", members: ["frontend", "backend", "mobile", "data"] },
      { name: QO, lead: "techlead", members: ["qa", "security", "devops"] }, { name: "Growth", lead: "marketer", members: ["researcher"] }] },
];

/** Build a template's agents and channels for a company (fresh ids, laid out as a tree). */
export function buildTemplate(reg: Registry, key: string, companyId: string): { agents: AgentOut[]; edges: EdgeOut[]; departments: CanvasExport["departments"] } {
  const t = BUILTIN_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new UserError(`Unknown template ${key}`, 404);
  const roles = new Map(effectiveRoles(reg).map((r) => [r.key, r]));
  const role = (k: string) => roles.get(k) ?? roles.get("developer")!;
  const agents: AgentOut[] = [];
  const add = (k: string, o: { department: string; manager?: boolean; entry?: boolean; reports_to?: string | null }) => {
    const r = role(k);
    const a = agentFromRole(companyId, r, { ...o, name: freshName(agents.map((x) => x.name), r.default_name) });
    agents.push(a);
    return a;
  };
  const head = add(t.head, { department: "Executive", entry: true });
  for (const d of t.departments) {
    const lead = add(d.lead, { department: d.name, manager: true, reports_to: head.id });
    for (const m of d.members ?? []) add(m, { department: d.name, reports_to: lead.id });
  }
  layoutTree(agents);
  return { agents, edges: wire(agents), departments: departmentsOf(agents, { Executive: { color: departmentColor("Executive"), description: "" } }) };
}

export function templateList(reg: Registry): TemplateOut[] {
  const builtin = BUILTIN_TEMPLATES.map((t): TemplateOut => {
    const people = [{ name: t.head, department: "Executive", is_manager: true }, ...t.departments.flatMap((d) => [
      { name: d.lead, department: d.name, is_manager: true }, ...(d.members ?? []).map((m) => ({ name: m, department: d.name, is_manager: false }))])];
    const roles = new Map(effectiveRoles(reg).map((r) => [r.key, r.role]));
    return { key: t.key, name: t.name, description: t.description, agent_count: people.length, edge_count: (people.length - 1) * 2,
      departments: departmentSummaries(people.map((p) => ({ ...p, name: roles.get(p.name) ?? p.name }))), source: "builtin", workflow: true, updated_at: null };
  });
  const user = reg.templates.find().map((t): TemplateOut => ({
    key: t.key, name: t.name, description: t.description, agent_count: t.spec.agents.length, edge_count: t.spec.edges.length,
    departments: departmentSummaries(t.spec.agents, t.spec.departments), source: "user", workflow: true, updated_at: t.updated_at,
  }));
  return [...builtin, ...user];
}
