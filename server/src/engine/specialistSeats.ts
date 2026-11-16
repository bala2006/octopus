/**
 * A specialist's seat on a company's canvas: an agent in the Specialists department that reports to the team lead, with a
 * delegate channel from the lead and a report channel back. Every solo conversation seats the specialists Settings turns on,
 * and the canvas adds one from the palette. A seat is added once and kept, so turning a specialist off hides its card
 * without deleting it.
 */
import type { AgentOut, EdgeOut, SpecialistName } from "@octopus/shared";
import type { Project } from "../workspace/projects";
import { now } from "../lib/util";
import { agentFromRole, departmentsOf, freshName, placeHire, wire } from "./org";
import { SPECIALIST_DEFS, specialistRole } from "./specialists";

export interface SeatResult { agent: AgentOut; edges: EdgeOut[]; added: boolean }

/** The company's agent for a specialist. It is added with its two channels the first time, and found on every later call. */
export function seatSpecialist(p: Project, companyId: string, name: SpecialistName): SeatResult {
  const team = p.db.agents.find("company_id = ?", [companyId]);
  const found = team.find((a) => a.behavior.template_key === specialistRole(name).key);
  if (found) return { agent: found, edges: [], added: false };
  const lead = team.find((a) => a.is_entry);
  if (!lead) throw new Error("The team has no lead agent to report to.");
  const title = SPECIALIST_DEFS[name].title;
  const agent = agentFromRole(companyId, specialistRole(name), { name: freshName(team.map((a) => a.name), title), department: "Specialists", reports_to: lead.id, created_by: lead.id });
  placeHire(team, agent);
  const edges = wire([...team, agent], p.db.edges.find("company_id = ?", [companyId]));
  const company = p.db.companies.get(companyId)!;
  p.db.tx(() => {
    p.db.agents.insert(agent);
    for (const e of edges) p.db.edges.insert(e);
    p.db.companies.update(company.id, { departments: departmentsOf([agent], company.departments), revision: company.revision + 1, updated_at: now() });
  });
  return { agent, edges, added: true };
}
