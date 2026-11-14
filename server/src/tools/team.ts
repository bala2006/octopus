/**
 * Collaboration tools. Specialists finish, block, ask the user, consult teammates, review and keep notes; the
 * orchestrator additionally hires and plans. Tools that end a turn return a `stop`.
 */
import { z } from "zod";
import { newId, now } from "../lib/util";
import { SHARED_MEMORY } from "../db/project";
import { defineTool, type ToolContext } from "./types";

const options = z.array(z.object({
  label: z.string().describe("Short answer the user can pick"),
  description: z.string().optional().describe("What choosing it means"),
  recommended: z.boolean().optional(),
})).max(5);

const findMate = (ctx: ToolContext, who: string) => {
  const q = who.trim().toLowerCase();
  return ctx.team().find((a) => a.id === who || a.name.toLowerCase() === q) ?? ctx.team().find((a) => a.role.toLowerCase() === q || a.name.toLowerCase().startsWith(q));
};

export const askUser = defineTool({
  name: "ask_user",
  description: "Ask the user a question you cannot answer from the project or the request: a real product decision, a missing credential, an ambiguous requirement. Offer 2-5 concrete options and mark the one you recommend. Do not ask for permission to do your job.",
  args: z.object({ question: z.string().min(5), options }),
  async run(_ctx, a) { return { text: "Question sent to the user.", stop: { kind: "ask", question: a.question, options: a.options } }; },
});

export const memoryTools = [
  defineTool({
    name: "remember",
    description: "Save a durable note for future work: a convention, a decision, a gotcha, where something lives. Set shared to make it visible to the whole team. Notes appear in your instructions next time.",
    args: z.object({ key: z.string().min(1).max(120), value: z.string().min(1).max(4000), shared: z.boolean().optional() }),
    async run(ctx, a) {
      const agent_id = a.shared ? SHARED_MEMORY : ctx.agent.id;
      const existing = ctx.db.memory.one("agent_id = ? AND key = ?", [agent_id, a.key]);
      ctx.db.memory.upsert({ id: existing?.id ?? newId(), agent_id, key: a.key, value: a.value, updated_at: now() });
      return { text: `Noted "${a.key}"${a.shared ? " for the whole team" : ""}.` };
    },
  }),
  defineTool({
    name: "forget",
    description: "Delete one of your notes (or a shared team note) that is wrong or out of date.",
    args: z.object({ key: z.string(), shared: z.boolean().optional() }),
    async run(ctx, a) {
      ctx.db.memory.removeWhere("agent_id = ? AND key = ?", [a.shared ? SHARED_MEMORY : ctx.agent.id, a.key]);
      return { text: `Forgot "${a.key}".` };
    },
  }),
];

export const consultTool = defineTool({
  name: "ask_teammate",
  description: "Ask a teammate a focused question (an API contract, a design decision, how something works) and wait for their answer. Use their name.",
  args: z.object({ teammate: z.string(), question: z.string().min(5) }),
  async run(ctx, a) {
    const mate = findMate(ctx, a.teammate);
    if (!mate) return { text: `No teammate called ${a.teammate}. Team: ${ctx.team().map((t) => `${t.name} (${t.role})`).join(", ")}`, ok: false };
    if (mate.id === ctx.agent.id) return { text: "That is you.", ok: false };
    ctx.setStatus("waiting", `Asking ${mate.name}`);
    return { text: `${mate.name}: ${await ctx.consult(mate, a.question)}` };
  },
});

export const workerTools = [
  defineTool({
    name: "complete_task",
    description: "Finish your task. Only call this when the acceptance criteria are met and you have verified the result (ran it, tested it, or re-read it). Summarise what you did, which files changed and how you verified it.",
    args: z.object({ summary: z.string().min(10), verification: z.string().describe("What you ran or checked, and the result") }),
    async run(_ctx, a) { return { text: "Task submitted.", stop: { kind: "complete", summary: a.summary, verification: a.verification } }; },
  }),
  defineTool({
    name: "block_task",
    description: "Stop because the task cannot be done as specified (missing dependency, contradiction, needs a decision from the lead). Explain exactly what is needed.",
    args: z.object({ reason: z.string().min(10) }),
    async run(_ctx, a) { return { text: "Reported as blocked.", stop: { kind: "block", reason: a.reason } }; },
  }),
];

export const acceptanceTool = defineTool({
  name: "submit_acceptance",
  description: "Submit the acceptance check: for every requirement you were asked to check, whether it is met and what you observed. Met means you saw it work in the running product (or proved it with a test), not that the code mentions it.",
  args: z.object({
    results: z.array(z.object({
      id: z.string().describe("Requirement id, e.g. R2"),
      met: z.boolean(),
      evidence: z.string().min(5).describe("What you did and saw; for unmet ones, what is missing or wrong"),
    })).min(1),
  }),
  async run(ctx, a) {
    const given = new Set(a.results.map((r) => r.id.trim().toUpperCase()));
    const missing = (ctx.task?.requirements ?? []).filter((id) => !given.has(id));
    if (missing.length) return { text: `Give a result for ${missing.join(", ")} too.`, ok: false };
    return { text: "Acceptance submitted.", stop: { kind: "acceptance", results: a.results.map((r) => ({ ...r, id: r.id.trim().toUpperCase() })) } };
  },
});

export const reviewTool = defineTool({
  name: "submit_review",
  description: "Submit your review. approve only if the work meets the acceptance criteria, is correct, secure and maintainable. Otherwise request_changes with numbered, actionable comments (file, problem, fix).",
  args: z.object({ verdict: z.enum(["approve", "request_changes"]), comments: z.string().min(5) }),
  async run(_ctx, a) { return { text: "Review submitted.", stop: { kind: "review", verdict: a.verdict, comments: a.comments } }; },
});

export const plannerTools = [
  defineTool({
    name: "hire_agent",
    description: "Add a specialist to the company (appears on the canvas). Prefer a role_key from the role library; for anything else give a precise title and instructions. Hire only for work that needs that expertise; reuse existing teammates first.",
    args: z.object({
      role_key: z.string().optional().describe("Key from the role library, e.g. frontend, backend, qa"),
      title: z.string().min(2).describe("Job title, e.g. 'Payments Engineer'"),
      name: z.string().optional().describe("A first name; leave empty to pick one"),
      department: z.string().min(2).describe("Department, e.g. Engineering, Product & Design, Quality & Ops"),
      reports_to: z.string().optional().describe("Name of their manager; defaults to you"),
      manager: z.boolean().optional().describe("True for a department lead who reviews their department's work"),
      instructions: z.string().optional().describe("Extra expertise or standards for a custom role"),
      reason: z.string().min(5).describe("Why the team needs this person"),
    }),
    async run(ctx, a) {
      const hired = ctx.planner!.hire(a);
      return { text: `Hired ${hired.name} (${hired.role}, ${hired.department}).` };
    },
  }),
  defineTool({
    name: "set_requirements",
    description: "Record what the user asked for, one requirement per explicit ask, in the user's own words (quote them; do not soften or merge them). Call it before create_task for any feature or product; small fixes and questions need none. Calling it again adds requirements. The team's work is accepted against this list.",
    args: z.object({ items: z.array(z.string().min(3)).min(1).describe("Each requirement, in the user's words") }),
    async run(ctx, a) {
      const added = ctx.planner!.addRequirements(a.items);
      return { text: `Recorded ${added.map((r) => `${r.id}: ${r.text}`).join("\n")}\nAssign each to a task with create_task requirements.` };
    },
  }),
  defineTool({
    name: "cut_requirement",
    description: "Leave a requirement out because it cannot be built in this environment (for example native 8K output in a browser). Never cut something only because it is hard: give it its own task instead. The user sees every cut and its reason.",
    args: z.object({ id: z.string().describe("Requirement id, e.g. R3"), reason: z.string().min(10).describe("Why it cannot be built here, and what is delivered instead") }),
    async run(ctx, a) {
      const r = ctx.planner!.cutRequirement(a.id, a.reason);
      return { text: `${r.id} is cut: ${r.note}` };
    },
  }),
  defineTool({
    name: "create_task",
    description: "Assign a task. One owner, a clear outcome, acceptance criteria someone can check, the requirements it delivers, the files or folders it owns, and dependencies by task key. Builders get kind build; documents docs; investigations research. Reviews, test runs and the final acceptance check are added automatically.",
    args: z.object({
      title: z.string().min(4),
      description: z.string().min(10).describe("What to do and the context the assignee needs: relevant files, interfaces, decisions"),
      acceptance_criteria: z.string().min(5).describe("Checkable bullet list"),
      assignee: z.string().describe("Teammate name"),
      kind: z.enum(["build", "docs", "research"]),
      depends_on: z.array(z.string()).optional().describe("Keys of tasks that must finish first, e.g. T1"),
      requirements: z.array(z.string()).optional().describe("Ids of the requirements this task delivers, e.g. R1, R4"),
      files: z.array(z.string()).optional().describe("Files and folders this task owns, e.g. src/world/, index.html. Tasks that own different paths run in parallel; a task with none runs alone"),
      skills: z.array(z.string()).optional().describe("Playbooks the assignee should follow, by name from the skill list"),
    }),
    async run(ctx, a) {
      const t = ctx.planner!.addTask({ ...a, depends_on: a.depends_on ?? [], requirements: a.requirements ?? [], files: a.files ?? [], skills: a.skills ?? [] });
      return { text: `Created ${t.key}: ${t.title} → ${ctx.team().find((m) => m.id === t.assignee_agent_id)?.name}` };
    },
  }),
  defineTool({
    name: "amend_task",
    description: "Change or add to an open task, for example when the user adds a constraint mid-run. The assignee gets the update before their next step. Prefer this to a new task when the work already covers it.",
    args: z.object({ task: z.string().describe("Task key, e.g. T3"), note: z.string().min(5).describe("What changes, in full") }),
    async run(ctx, a) {
      const t = ctx.planner!.amendTask(a.task, a.note);
      return { text: `Updated ${t.key}.` };
    },
  }),
  defineTool({
    name: "start_work",
    description: "Finish planning and let the team start. Call once the tasks cover the whole request: every requirement is assigned to a task or cut.",
    args: z.object({ note: z.string().describe("One or two sentences for the user: the plan and who does what") }),
    async run(ctx, a) {
      const p = ctx.planner!;
      if (!p.tasks().some((t) => t.status === "todo")) return { text: "There are no open tasks. Create tasks first, or use reply_to_user if no work is needed.", ok: false };
      const owned = new Set(p.tasks().flatMap((t) => t.requirements));
      const loose = p.requirements().filter((r) => r.status === "open" && !owned.has(r.id));
      if (loose.length) return { text: `No task delivers ${loose.map((r) => `${r.id} (${r.text})`).join(", ")}. Add them to a task's requirements, or cut_requirement with the reason.`, ok: false };
      return { text: "The team is starting.", stop: { kind: "plan_ready", note: a.note } };
    },
  }),
  defineTool({
    name: "reply_to_user",
    description: "Answer the user directly when no project work is needed (a question, an explanation, a status update), or after reviewing the team's results.",
    args: z.object({ message: z.string().min(1) }),
    async run(_ctx, a) { return { text: "Sent.", stop: { kind: "reply", message: a.message } }; },
  }),
];
