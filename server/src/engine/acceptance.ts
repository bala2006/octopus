/**
 * The verifier's asks: each thing the user asked for in this request, checked against the running product and recorded
 * as met or not met. The verifier writes the asks from the user's messages, so the list follows the user's words and not
 * the main agent's summary.
 */
import type { Requirement } from "@octopus/shared";

/** One ask the verifier checked. `id` is the requirement id the ask has in the run's list. */
export interface Ask { id: string; ask: string; met: boolean; evidence: string }

/** One entry of the verifier's submission. An id that was listed checks that ask again; no id makes a new ask. */
export interface Verdict { id?: string; ask: string; met: boolean; evidence: string }

/**
 * Folds a round's verdicts into the request's asks. A first round that does not submit an ask counts it as not met, since
 * nothing checked it. A re-check round only checks the asks that were not met, so an ask it leaves out keeps its verdict.
 * `nextId` names each new ask.
 */
export function foldVerdicts(asks: Ask[], verdicts: Verdict[], nextId: () => string, recheck = false): Ask[] {
  const known = new Set(asks.map((a) => a.id));
  const listed = (v: Verdict) => v.id !== undefined && known.has(v.id);
  const byId = new Map(verdicts.filter(listed).map((v) => [v.id!, v]));
  const kept = asks.map((a): Ask => {
    if (recheck && a.met) return a; // a re-check does not judge again an ask that already passed
    const v = byId.get(a.id);
    if (v) return { id: a.id, ask: v.ask, met: v.met, evidence: v.evidence };
    return recheck ? a : { ...a, met: false, evidence: "The verifier did not check this ask in this round." };
  });
  const added = verdicts.filter((v) => !listed(v)).map((v): Ask => ({ id: nextId(), ask: v.ask, met: v.met, evidence: v.evidence }));
  return [...kept, ...added];
}

/** Asks that are fragments of a sentence the user wrote, such as "and best user experience.": too short, or starting with a conjunction. */
export function fragmentAsks(texts: string[]): string[] {
  return texts.filter((t) => t.trim().split(/\s+/).length < 3 || /^(and|or|but|also|plus)\b/i.test(t.trim()));
}

/** The requirement the run's list shows for an ask: met or unmet, with the evidence as its note. */
export function toRequirement(a: Ask): Requirement {
  return { id: a.id, text: a.ask, status: a.met ? "met" : "unmet", note: a.evidence };
}

/** The message a verifier round sends the main agent: how many asks it met, and each ask it did not, with its evidence. */
export function verdictMessage(round: number, asks: Ask[], limit: number): string {
  const met = asks.filter((a) => a.met).length;
  const lines = [`Acceptance check, round ${round}: ${met} of ${asks.length} asks met.`];
  for (const a of asks) if (!a.met) lines.push(`\n${a.id} not met: ${a.ask}\nEvidence: ${a.evidence}`);
  if (met < asks.length) lines.push("\nFix each ask that is not met, then reply. An ask that is met needs nothing.");
  const text = lines.join("\n");
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n(cut at ${limit} characters)`;
}

/** Why a request ends incomplete when its acceptance checks have run out and the last change came after the last one. */
export function uncheckedChangeReason(rounds: number, unmet: string[]): string {
  const checks = rounds === 1 ? "One acceptance check" : `${rounds} acceptance checks`;
  const left = unmet.length ? `${checks} left ${unmet.join(", ")} not met` : `${checks} met every ask`;
  return `${left}, and the last change was not checked against the requirements.`;
}
