/**
 * The plan a lead agent records before it works: the roles it uses, what each step needs and leaves behind, and why each
 * role is in the plan. The checks here are commitments the plan has to keep, not an order the work must follow. Any
 * shape that keeps them is valid: a plan may have one step or many, and steps may run in any order their inputs allow.
 */
import type { PlanStep } from "@octopus/shared";

export interface PlanCheck { ok: boolean; errors: string[] }

export function checkPlan(steps: PlanStep[]): PlanCheck {
  const errors: string[] = [];
  const byId = new Map<string, PlanStep>();
  for (const s of steps) {
    const label = s.id.trim() || "(no id)";
    if (!s.id.trim()) errors.push("A step has no id.");
    else if (byId.has(s.id)) errors.push(`Step id ${s.id} is used twice.`);
    else byId.set(s.id, s);
    if (!s.role.trim()) errors.push(`Step ${label} has no role.`);
    if (!s.purpose.trim()) errors.push(`Step ${label} has no purpose.`);
    if (!s.reason.trim()) errors.push(`Step ${label} needs a reason for its role.`);
    if (s.skip !== undefined && !s.skip.trim()) errors.push(`Step ${label} is skipped without a reason.`);
  }
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (d === s.id) errors.push(`Step ${s.id} depends on itself.`);
      else if (!byId.has(d)) errors.push(`Step ${s.id} depends on ${d}, which is not in the plan.`);
    }
  }
  const cycle = findCycle(byId);
  if (cycle) errors.push(`The steps depend on each other in a loop: ${cycle.join(" -> ")}.`);

  // Every step can read what the steps it depends on (directly or through others) produce.
  const reach = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(d) || seen.has(d)) continue;
      seen.add(d);
      reach(d, seen);
    }
    return seen;
  };
  for (const s of steps) {
    const upstream = reach(s.id);
    for (const input of s.inputs) {
      const producers = steps.filter((p) => p.produces.includes(input));
      if (producers.length === 0) errors.push(`Step ${s.id} reads ${input}, which no step produces.`);
      else if (!producers.some((p) => upstream.has(p.id))) errors.push(`Step ${s.id} reads ${input}, but the step that produces it is not one it depends on.`);
      else if (s.skip === undefined) {
        for (const p of producers) if (p.skip !== undefined && upstream.has(p.id)) errors.push(`Step ${s.id} reads ${input} from step ${p.id}, which is skipped.`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The steps forming a dependency loop, in order, or null when the plan has none. */
function findCycle(byId: Map<string, PlanStep>): string[] | null {
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(d)) continue;
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of byId.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return null;
}
