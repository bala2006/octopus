/**
 * Who may do what on a part. One writer changes the product's files. Critics read, run and look, then report findings
 * to the writer. The lead plans the work and reviews the result. A critic is never given write access.
 */
import type { AgentOut } from "@octopus/shared";

export type Kind = "writer" | "critic" | "lead";

/** Built-in role templates, by the template key stored on each agent. */
const BUILTIN: Record<string, Kind> = {
  developer: "writer", frontend: "writer", backend: "writer", mobile: "writer", data: "writer", devops: "writer",
  writer: "writer", marketer: "writer",
  orchestrator: "lead", ceo: "critic", pm: "critic", designer: "critic", architect: "critic", techlead: "critic",
  qa: "critic", security: "critic", researcher: "critic",
};

/** A team member's kind. A custom role that may write is a writer; one that may not is a critic. */
export function kindOf(agent: Pick<AgentOut, "behavior" | "tools" | "is_manager">): Kind {
  if (agent.is_manager) return "lead";
  const key = agent.behavior.template_key ?? "";
  if (key in BUILTIN) return BUILTIN[key]!;
  return agent.tools.file_write === false ? "critic" : "writer";
}

/** Why a part cannot be staffed this way, or null. One writer owns the part; specialists only critique it. */
export function staffingError(owner: AgentOut, specialists: AgentOut[]): string | null {
  const kind = kindOf(owner);
  if (kind !== "writer") return `${owner.name} is not a writer, so cannot own a part. Give the part to a writer on the team.`;
  for (const s of specialists) {
    if (s.id === owner.id) return `${s.name} owns this part, so cannot also critique it.`;
    if (kindOf(s) !== "critic") return `${s.name} writes files, so cannot critique this part. Specialists only read and report findings.`;
  }
  return null;
}
