/**
 * Who may do what on a part. One writer changes the product's files. Critics read, run and look, then report findings
 * to the writer. The lead plans the work and reviews the result.
 *
 * A role's kind comes from what the role is (the built-in library, or a custom role's file-write switch), never from
 * where it sits on the org chart: a department lead who builds still owns their part, and a department lead who
 * reviews still reviews. `is_manager` decides who reviews whom, not what anyone can do.
 */
import type { AgentOut } from "@octopus/shared";

export type Kind = "writer" | "critic" | "lead";

/** Built-in roles, by template key. */
const BUILTIN: Record<string, Kind> = {
  developer: "writer", frontend: "writer", backend: "writer", mobile: "writer", data: "writer", devops: "writer",
  writer: "writer", marketer: "writer",
  ceo: "lead", pm: "lead", orchestrator: "lead",
  designer: "critic", architect: "critic", techlead: "critic", codequality: "critic", duplication: "critic",
  qa: "critic", security: "critic", researcher: "critic",
};

/** A team member's kind. A custom role that may write is a writer; one that may not is a critic. */
export function kindOf(agent: Pick<AgentOut, "behavior" | "tools">): Kind {
  const key = agent.behavior.template_key ?? "";
  return BUILTIN[key] ?? (agent.tools.file_write === false ? "critic" : "writer");
}

/** Can own a part: it is a writer, whatever rank it holds. */
export const canWrite = (agent: AgentOut): boolean => kindOf(agent) === "writer";

/** Can be attached to a part as a specialist: a critic that can read the work. */
export const canReview = (agent: AgentOut): boolean => kindOf(agent) === "critic" && agent.tools.file_read !== false;

/** Can judge the finished product against what the user asked: it can read, and run or open it. */
export const canVerify = (agent: AgentOut): boolean => canReview(agent) && (!!agent.tools.terminal || !!agent.tools.browser);

/** Why a part cannot be staffed this way, or null. One writer owns the part; specialists only critique it. */
export function staffingError(owner: AgentOut, specialists: AgentOut[]): string | null {
  if (!canWrite(owner)) {
    return kindOf(owner) === "lead"
      ? `${owner.name} leads the work, so cannot own a part. Give the part to a writer on the team.`
      : `${owner.name} is not a writer, so cannot own a part. Give the part to a writer on the team.`;
  }
  for (const s of specialists) {
    if (s.id === owner.id) return `${s.name} owns this part, so cannot also critique it.`;
    if (canReview(s)) continue;
    return kindOf(s) === "writer"
      ? `${s.name} writes files, so cannot critique this part. Specialists only read and report findings.`
      : `${s.name} cannot read the project, so cannot critique this part.`;
  }
  return null;
}
