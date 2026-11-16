import type { SpecialistName, SpecialistsSettings } from "@octopus/shared";
import { SPECIALIST_ORDER } from "@/features/settings/specialistSettings";

/** The template key of a solo conversation's lead, Octopus. A company with this lead is a solo canvas. */
export const SOLO_LEAD_KEY = "main";
const SPECIALIST_PREFIX = "specialist-";
/** Any agent: a solo canvas reads only its behavior. */
type Behaved = { behavior?: { template_key?: string | null } | null };

/** The specialist an agent stands for, or null for any other agent. */
export function specialistOf(agent: Behaved): SpecialistName | null {
  const key = agent.behavior?.template_key ?? "";
  if (!key.startsWith(SPECIALIST_PREFIX)) return null;
  const name = key.slice(SPECIALIST_PREFIX.length);
  return (SPECIALIST_ORDER as readonly string[]).includes(name) ? (name as SpecialistName) : null;
}

export const isSoloCanvas = (agents: Behaved[]): boolean => agents.some((a) => a.behavior?.template_key === SOLO_LEAD_KEY);

/** The agents a solo canvas draws: Octopus and every other non-specialist agent, plus each specialist Settings turns on. */
export function soloCards<T extends Behaved>(agents: T[], specialists: SpecialistsSettings["specialists"]): T[] {
  return agents.filter((a) => {
    const name = specialistOf(a);
    return name === null || specialists[name].enabled;
  });
}

/** The ids of specialist agents Settings turns off. Their cards stay in the company and are only hidden on the canvas. */
export function hiddenCardIds<T extends Behaved & { id: string }>(agents: T[], specialists: SpecialistsSettings["specialists"]): Set<string> {
  return new Set(agents.filter((a) => {
    const name = specialistOf(a);
    return name !== null && !specialists[name].enabled;
  }).map((a) => a.id));
}

/** The specialists Settings turns on that the company has no agent for yet. */
export function unseatedSpecialists<T extends Behaved>(agents: T[], specialists: SpecialistsSettings["specialists"]): SpecialistName[] {
  const seated = new Set(agents.map(specialistOf).filter((n): n is SpecialistName => n !== null));
  return SPECIALIST_ORDER.filter((n) => specialists[n].enabled && !seated.has(n));
}
