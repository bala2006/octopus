/** Companies: the team on the canvas. Create from a template, design with AI, import/export, autosave, agent memory. */
import {
  CanvasExportSchema, CanvasStateSchema, CompanyInSchema, CompanyPatchSchema, GenerateCompanySchema, InstantiateTemplateSchema, MemoryInSchema, UserTemplateInSchema,
  type AgentIn, type AgentOut, type CanvasExport, type CanvasOut, type CompanyOut, type DepartmentMeta, type EdgeIn, type EdgeOut,
} from "@octopus/shared";
import { config } from "../../config";
import type { CompanyRow, ProjectDb } from "../../db/project";
import type { Registry } from "../../db/registry";
import { effectiveRoles, roleByKey } from "../../catalog/roles";
import { buildTemplate } from "../../catalog/templates";
import { agentFromRole, departmentColor, departmentsOf, departmentSummaries, freshName, layoutTree, wire } from "../../engine/org";
import { complete } from "../../llm/azure";
import { newId, notFound, now, parseJson, UserError } from "../../lib/util";
import type { RouteFn } from "../router";
import { saveUserTemplate, templateSpec } from "./catalog";

const companyOut = (db: ProjectDb, c: CompanyRow): CompanyOut => ({
  id: c.id, name: c.name, description: c.description, created_at: c.created_at, updated_at: c.updated_at,
  agent_count: db.agents.count("company_id = ?", [c.id]),
});

export function canvasOut(db: ProjectDb, companyId: string): CanvasOut {
  const c = db.companies.get(companyId);
  if (!c) throw notFound("Team");
  return { company: companyOut(db, c), agents: db.agents.find("company_id = ?", [c.id]), edges: db.edges.find("company_id = ?", [c.id]),
    departments: c.departments, viewport: c.viewport, revision: c.revision };
}

function agentOut(companyId: string, a: AgentIn, id: string): AgentOut {
  return {
    id, company_id: companyId, name: a.name, role: a.role ?? "", description: a.description ?? "", system_prompt: a.system_prompt ?? "", department: a.department ?? "",
    is_entry: !!a.is_entry, is_manager: !!a.is_manager, reports_to: a.reports_to ?? null, avatar: a.avatar ?? "bot", color: a.color ?? "#66839A",
    model: a.model || config.defaultModel, provider: "azure", temperature: a.temperature ?? 0.4, max_tokens: a.max_tokens ?? 32_000,
    position_x: a.position_x ?? 0, position_y: a.position_y ?? 0, active: a.active ?? true, tools: a.tools ?? {}, behavior: a.behavior ?? {}, created_by: a.created_by ?? null,
  };
}

const edgeOut = (companyId: string, e: EdgeIn, id: string, map: (x: string) => string): EdgeOut => ({
  id, company_id: companyId, source_agent_id: map(e.source_agent_id), target_agent_id: map(e.target_agent_id), type: e.type ?? "delegate",
  label: e.label ?? "", bidirectional: !!e.bidirectional, config: e.config ?? {},
});

/** Create a company from agents and channels, giving everything fresh ids. */
function createCompany(db: ProjectDb, name: string, description: string, agents: AgentIn[], edges: EdgeIn[], departments: Record<string, DepartmentMeta> = {}): CanvasOut {
  const id = newId();
  const ids = new Map(agents.map((a, i) => [a.id ?? `#${i}`, newId()]));
  const map = (x: string) => ids.get(x) ?? x;
  const out = agents.map((a, i) => ({ ...agentOut(id, a, ids.get(a.id ?? `#${i}`)!), reports_to: a.reports_to ? ids.get(a.reports_to) ?? null : null }));
  if (!out.some((a) => a.is_entry) && out[0]) out[0].is_entry = true;
  db.tx(() => {
    db.companies.insert({ id, name, description, departments: departmentsOf(out, departments), viewport: null, revision: 1, created_at: now(), updated_at: now() });
    for (const a of out) db.agents.insert(a);
    for (const e of edges) if (ids.has(e.source_agent_id) && ids.has(e.target_agent_id)) db.edges.insert(edgeOut(id, e, newId(), map));
  });
  return canvasOut(db, id);
}

export function exportCompany(db: ProjectDb, companyId: string): CanvasExport {
  const c = canvasOut(db, companyId);
  return { format: "octopus.company/v1", name: c.company.name, description: c.company.description, agents: c.agents, edges: c.edges, departments: c.departments };
}

/** Ask the model to design a team for a description, built from the role library. */
async function generate(reg: Registry, prompt: string, max: number, model?: string | null): Promise<CanvasExport> {
  const roles = effectiveRoles(reg);
  const res = await complete(reg, {
    model: model || config.defaultModel, effort: "medium", maxOutputTokens: 8000,
    instructions: `You design the org chart of a small AI company for a software developer. Use role keys from this library where they fit:\n${roles.map((r) => `- ${r.key}: ${r.role}`).join("\n")}\n` +
      `Reply with JSON only: {"name": string, "description": string, "head": role key (usually "orchestrator" or "ceo"), "departments": [{"name": string, "lead": {"role_key": string, "title"?: string}, "members": [{"role_key"?: string, "title": string, "instructions"?: string}]}]}. ` +
      `At most ${max} people in total. Every department has one lead. Size the team to the work; do not pad it.`,
    input: [{ role: "user", content: prompt }],
  });
  const spec = parseJson<{ name?: string; description?: string; head?: string; departments?: { name: string; lead: { role_key?: string; title?: string }; members?: { role_key?: string; title?: string; instructions?: string }[] }[] }>(
    res.text.replace(/^```(json)?|```$/gm, "").trim(), {});
  if (!spec.departments) throw new UserError("The model did not return a team design. Try describing the work differently.");
  const fallback = roles.find((r) => r.key === "developer")!;
  const pick = (k?: string) => roles.find((r) => r.key === k) ?? fallback;
  const agents: AgentOut[] = [];
  const add = (key: string | undefined, o: { department: string; manager?: boolean; entry?: boolean; reports_to?: string | null; title?: string; instructions?: string }) => {
    const r = pick(key);
    const a = agentFromRole("preview", r, { ...o, name: freshName(agents.map((x) => x.name), r.default_name), title: o.title || (key && roles.some((x) => x.key === key) ? undefined : o.title) });
    agents.push(a);
    return a;
  };
  const head = add(spec.head ?? "orchestrator", { department: "Executive", entry: true });
  for (const d of spec.departments) {
    if (agents.length >= max) break;
    const lead = add(d.lead.role_key, { department: d.name, manager: true, reports_to: head.id, title: d.lead.title });
    for (const m of d.members ?? []) if (agents.length < max) add(m.role_key, { department: d.name, reports_to: lead.id, title: m.title, instructions: m.instructions });
  }
  layoutTree(agents);
  return { format: "octopus.company/v1", name: spec.name || "AI-designed team", description: spec.description ?? prompt.slice(0, 200), agents, edges: wire(agents),
    departments: departmentsOf(agents, { Executive: { color: departmentColor("Executive") } }) };
}

export function companyRoutes(route: RouteFn, reg: Registry) {
  const W = "/api/v1/w/{workspace_id}" as const;
  route("GET", `${W}/companies`, ({ project }) => {
    const db = project().db;
    return db.companies.find("1=1", [], "updated_at DESC").map((c) => companyOut(db, c));
  });
  route("POST", `${W}/companies`, CompanyInSchema, ({ project, body }) => {
    const lead = agentFromRole("new", roleByKey(reg, "orchestrator")!, { name: "Octopus", department: "Executive", entry: true });
    return createCompany(project().db, body.name, body.description ?? "", [lead], []);
  });
  route("POST", `${W}/companies/from-template`, InstantiateTemplateSchema, ({ project, body }) => {
    const db = project().db;
    if (reg.templates.get(body.template_key)) {
      const spec = templateSpec(reg, body.template_key);
      return createCompany(db, body.name || spec.name, spec.description ?? "", spec.agents, spec.edges, spec.departments);
    }
    const built = buildTemplate(reg, body.template_key, "new");
    const name = body.name || (body.template_key === "adaptive" ? "Octopus" : templateSpec(reg, body.template_key).name);
    return createCompany(db, name, body.goal ? `Formed for: ${body.goal.slice(0, 200)}` : "", built.agents, built.edges, built.departments);
  });
  route("POST", `${W}/companies/generate`, GenerateCompanySchema, async ({ body }) => {
    const spec = await generate(reg, body.prompt, body.max_agents ?? 14, body.model);
    return { spec, source: "ai" as const, departments: departmentSummaries(spec.agents, spec.departments) };
  });
  route("POST", `${W}/companies/import`, CanvasExportSchema, ({ project, body }) => createCompany(project().db, body.name, body.description ?? "", body.agents, body.edges, body.departments));
  route("GET", `${W}/companies/{company_id}`, ({ project, params }) => canvasOut(project().db, params.company_id));
  route("PATCH", `${W}/companies/{company_id}`, CompanyPatchSchema, ({ project, params, body }) => {
    const db = project().db;
    const c = db.companies.get(params.company_id);
    if (!c) throw notFound("Team");
    return companyOut(db, db.companies.update(c.id, { name: body.name ?? c.name, description: body.description ?? c.description, updated_at: now() })!);
  });
  route("DELETE", `${W}/companies/{company_id}`, ({ project, params }) => { project().db.companies.remove(params.company_id); return { ok: true }; });

  route("PUT", `${W}/companies/{company_id}/canvas`, CanvasStateSchema, ({ project, params, body }) => {
    const db = project().db;
    const c = db.companies.get(params.company_id);
    if (!c) throw notFound("Team");
    if (body.revision != null && body.revision < c.revision) throw new UserError("The team changed while you were editing (someone was hired). Reloaded the latest version.", 409);
    db.tx(() => {
      const keep = new Set<string>();
      for (const a of body.agents) {
        const id = a.id || newId();
        keep.add(id);
        db.agents.upsert(agentOut(c.id, a, id));
      }
      for (const a of db.agents.find("company_id = ?", [c.id])) if (!keep.has(a.id)) db.agents.remove(a.id);
      db.edges.removeWhere("company_id = ?", [c.id]);
      for (const e of body.edges) if (keep.has(e.source_agent_id) && keep.has(e.target_agent_id)) db.edges.insert(edgeOut(c.id, e, e.id || newId(), (x) => x));
      db.companies.update(c.id, { departments: body.departments ? departmentsOf([], body.departments) : c.departments, viewport: body.viewport ?? c.viewport, revision: c.revision + 1, updated_at: now() });
    });
    return canvasOut(db, c.id);
  });
  route("GET", `${W}/companies/{company_id}/export`, ({ project, params }) => exportCompany(project().db, params.company_id));
  route("POST", `${W}/companies/{company_id}/save-template`, UserTemplateInSchema, ({ project, params, body }) =>
    saveUserTemplate(reg, body.name, body.description ?? "", exportCompany(project().db, params.company_id)));

  route("GET", `${W}/agents/{agent_id}/memory`, ({ project, params }) => project().db.memory.find("agent_id = ?", [params.agent_id], "key"));
  route("PUT", `${W}/agents/{agent_id}/memory`, MemoryInSchema, ({ project, params, body }) => {
    const db = project().db;
    const existing = db.memory.one("agent_id = ? AND key = ?", [params.agent_id, body.key]);
    return db.memory.upsert({ id: existing?.id ?? newId(), agent_id: params.agent_id, key: body.key, value: body.value, updated_at: now() });
  });
  route("DELETE", `${W}/agents/{agent_id}/memory/{key}`, ({ project, params }) => {
    project().db.memory.removeWhere("agent_id = ? AND key = ?", [params.agent_id, decodeURIComponent(params.key)]);
    return { ok: true };
  });
}
