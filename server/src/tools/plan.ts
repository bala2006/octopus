/** The plan a solo main agent records before it changes files: its steps, what each reads and produces, and why it is there. */
import { z } from "zod";
import { checkPlan } from "../engine/plan";
import { defineTool } from "./types";

const StepSchema = z.object({
  id: z.string().min(1).describe("A short id, unique in the plan, such as research or build"),
  role: z.string().min(1).describe("Who does the step: explorer, verifier, reviewer, designer, security, or main for your own work"),
  purpose: z.string().min(1).describe("What the step does for this request"),
  depends_on: z.array(z.string()).describe("Ids of the steps that must finish before this one"),
  produces: z.array(z.string()).describe("What the step leaves behind, such as research.md or a list of findings"),
  inputs: z.array(z.string()).describe("What the step reads, each produced by a step it depends on"),
  reason: z.string().min(1).describe("Why this role is needed for this request"),
  skip: z.string().optional().describe("Set only when the step is planned but will not run: why it is skipped"),
});

export const setPlanTool = defineTool({
  name: "set_plan",
  description: "Record the plan for this request before you change files: one step per role you use, with what each reads and produces and why it is needed. A step you decide not to run stays in the plan, marked skip with the reason. Call it again to replace the plan.",
  args: z.object({ steps: z.array(StepSchema).min(1).describe("The complete plan, replacing any earlier one") }),
  async run(ctx, a) {
    const check = checkPlan(a.steps);
    if (!check.ok) return { text: `The plan is not valid, so it was not recorded:\n- ${check.errors.join("\n- ")}`, ok: false };
    ctx.emit("plan_updated", { agent_id: ctx.agent.id, steps: a.steps });
    const skipped = a.steps.filter((s) => s.skip !== undefined).length;
    return { text: `Plan recorded: ${a.steps.length} steps, ${skipped} skipped.` };
  },
});
