/**
 * Who may do what on a part. One writer changes the product's files. Critics read, run and look, then report findings
 * to the writer. The lead plans the work and reviews the result.
 *
 * What an agent may do is decided by its toolbox: a role can write only when its file tools are on, whatever its
 * built-in role says. Rank (department lead or not) plays no part, and `is_manager` decides who reviews whom.
 */
import type { AgentOut } from "@octopus/shared";

export type Kind = "writer" | "critic" | "lead";

/** Built-in roles, by template key: what each one is for. Its tools decide what it can actually do. */
const BUILTIN: Record<string, Kind> = {
  developer: "writer", frontend: "writer", backend: "writer", mobile: "writer", data: "writer", devops: "writer",
  writer: "writer", marketer: "writer",
  ceo: "lead", pm: "lead", orchestrator: "lead",
  designer: "critic", architect: "critic", techlead: "critic", codequality: "critic", duplication: "critic",
  qa: "critic", security: "critic", researcher: "critic",
};

/** Whether the toolbox lets an agent change files: it may write, and it can read what it changes. */
export const toolboxCanWrite = (tools: AgentOut["tools"]): boolean => tools.file_write !== false && tools.file_read !== false;

/** Whether the role is meant to build. A custom role builds unless its file-write switch is off. */
const builds = (agent: Pick<AgentOut, "behavior">): boolean => {
  const declared = BUILTIN[agent.behavior.template_key ?? ""];
  return declared === undefined ? true : declared === "writer";
};

/** Can own a part: a role meant to build, whose toolbox lets it change files. */
export const canWrite = (agent: Pick<AgentOut, "behavior" | "tools">): boolean => builds(agent) && toolboxCanWrite(agent.tools);

/**
 * What an agent is. A lead role plans and never owns a part. Any other agent writes only when `canWrite`, and otherwise
 * reads and reports as a critic, so a built-in writer whose file tools are off is still useful as a reviewer.
 */
export function kindOf(agent: Pick<AgentOut, "behavior" | "tools">): Kind {
  if (BUILTIN[agent.behavior.template_key ?? ""] === "lead") return "lead";
  return canWrite(agent) ? "writer" : "critic";
}

/** Can be attached to a part as a specialist: a critic that can read the work. */
export const canReview = (agent: AgentOut): boolean => kindOf(agent) === "critic" && agent.tools.file_read !== false;

/** Can judge the finished product against what the user asked: it can read, and run or open it. */
export const canVerify = (agent: AgentOut): boolean => canReview(agent) && (!!agent.tools.terminal || !!agent.tools.browser);

/** Why a part cannot be staffed this way, or null. One writer owns the part; specialists only critique it. */
export function staffingError(owner: AgentOut, specialists: AgentOut[]): string | null {
  if (!canWrite(owner)) {
    if (kindOf(owner) === "lead") return `${owner.name} leads the work, so cannot own a part. Give the part to a writer on the team.`;
    if (!toolboxCanWrite(owner.tools)) return `${owner.name} cannot change files with its current tools, so cannot own a part. Give the part to a writer on the team.`;
    return `${owner.name} is not a writer, so cannot own a part. Give the part to a writer on the team.`;
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
