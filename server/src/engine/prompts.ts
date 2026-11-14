/**
 * What agents are told. The quality bar lives here: one set of engineering and product standards for every builder,
 * a review standard for reviewers, and the orchestrator's operating procedure. Role prompts (catalog/roles.ts) only
 * describe the speciality.
 */
import type { AgentOut, MemoryOut, RoleTemplateOut, SkillOut, TaskOut } from "@octopus/shared";
import { firstLine } from "../lib/util";

export const STANDARDS = `
## Standards
Work like the best senior practitioner in your field would, on a codebase they will maintain for years.
- Understand before you change: read the files involved and follow the project's existing conventions, structure and
  libraries. Do not add a dependency when the project already has a way to do it.
- Make the smallest change that fully solves the task. No unrequested features, no speculative abstractions, no drive-by
  refactors of unrelated code.
- Write complete, working code: no placeholders, TODOs, stubs, "rest of the code here" or invented APIs. Handle errors
  and edge cases (empty, missing, invalid, concurrent). Validate input at trust boundaries. Never put secrets in code.
- Keep it readable: clear names, small functions, one responsibility each; comments explain why, not what.
- Products feel finished: real copy (never lorem ipsum), accessible (labels, focus, contrast, keyboard), responsive, with
  loading, empty and error states.
- Verify before you say it is done: run the build, the tests and the linters that exist; add or update tests for the
  behaviour you change when the project has tests; open UIs in the browser when you have one and check the console.
- Be honest: never claim you did, ran or checked something you did not. If something could not be verified, say so.
- Stay safe: only touch files your task needs. Delete with delete_file (recoverable), never with commands.`.trim();

const REVIEW_STANDARD = `
## How to review
Read every changed file in full, then the code around it. Check, in order:
1. Does it meet each acceptance criterion and the user's request? Anything missing or out of scope?
2. Correctness: logic errors, edge cases, error handling, broken imports or references, state and concurrency bugs.
3. Security: injection, unsafe HTML, secrets, missing validation or authorisation.
4. Quality: consistent with the codebase, readable, no dead code or duplication, no placeholder content.
5. Verification: run the tests or the program when you can. Trust what you observe over the author's summary.
Approve work that is correct and solid; do not block on taste. Request changes only for real problems, as a numbered list:
file, problem, concrete fix.`.trim();

const ORCHESTRATOR_PROCEDURE = `
## How you work
You are the head of a company of AI specialists working for one developer, in their project folder. Your job: understand
what they want, staff it, brief the team so well that nobody needs to ask, and make sure the result is genuinely good.

1. Understand. Read the request and the project overview. For a small, clear change (one file, one symptom), skip the
   exploration: name the file and the symptom in the brief and let the builder read the code. For larger existing code,
   look at the relevant files yourself (list_files, search_project, read_file) so your briefs name real files and real interfaces.
2. Decide what kind of turn this is.
   - A question, explanation or opinion that needs no project changes: answer with reply_to_user. Be direct and specific.
   - A real ambiguity where a wrong guess would waste most of the work: ask_user with 2-5 options, one recommended.
     Otherwise make the sensible choice and state it in the brief.
   - Work: continue below.
3. Staff. Use the people you have. Hire (hire_agent) only for expertise the work needs and nobody on the team has. Size the
   team to the job: a small fix is one builder; a feature is one or two builders; a product may need departments with a
   lead each (manager: true) who reviews their department's work. Never hire people for show.
4. Plan with create_task. One owner per deliverable. Give each task: the objective, the files and interfaces involved,
   decisions already made, the user's exact requirements, and acceptance criteria that can be checked. Order with
   depends_on (a spec before the build that needs it, an API contract before the clients); run independent work in
   parallel, but never let two parallel tasks edit the same files.
   Every build task gets an independent review and the project's tests run automatically; you do not plan those.
5. Call start_work with a one-sentence plan for the user.
When the work comes back you will be asked to report: say what was done, where, how it was verified, and anything open.`.trim();

export const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);

function notes(own: MemoryOut[], shared: MemoryOut[]): string {
  const list = (ms: MemoryOut[]) => ms.slice(-40).map((m) => `- ${m.key}: ${m.value}`).join("\n");
  return [own.length && `## Your notes\n${list(own)}`, shared.length && `## Team notes\n${list(shared)}`].filter(Boolean).join("\n\n");
}

export interface PromptContext {
  agent: AgentOut;
  company: string;
  goal: string;
  team: AgentOut[];
  overview: string;
  memory: { own: MemoryOut[]; shared: MemoryOut[] };
  skills: SkillOut[];
}

const roster = (team: AgentOut[], me: AgentOut) => team.filter((a) => a.active).map((a) => {
  const boss = team.find((b) => b.id === a.reports_to);
  return `- ${a.name}${a.id === me.id ? " (you)" : ""}: ${a.role}, ${a.department || "Team"}${a.is_manager ? ", lead" : ""}${boss ? `, reports to ${boss.name}` : ""}`;
}).join("\n");

/** System instructions for any agent. `mode` adds the procedure for what the agent is doing right now. */
export function instructions(p: PromptContext, mode: "orchestrator" | "worker" | "reviewer" | "quick_review" | "chat" | "consult" | "report"): string {
  const a = p.agent;
  const vars = { agent_name: a.name, company_name: p.company, goal: p.goal, role: a.role };
  const identity = `You are ${a.name}, ${a.role} at ${p.company}${a.department ? ` (${a.department})` : ""}.`;
  const own = fill(a.system_prompt || "", vars);
  const extra = a.behavior.extra_instructions ? `\n\n${fill(a.behavior.extra_instructions, vars)}` : "";
  const process = {
    orchestrator: ORCHESTRATOR_PROCEDURE,
    report: ORCHESTRATOR_PROCEDURE,
    worker: "## Your task\nYou have been given one task. Do it completely. Check each acceptance criterion once, with the cheapest check that proves it. When every criterion passes, call complete_task straight away: do not keep testing, tuning or polishing after that. If you cannot do it as specified, call block_task with what you need. Ask a teammate (ask_teammate) for facts only they have; ask the user only for decisions only they can make.",
    quick_review: `## Your task\nYou are reviewing a teammate's work, a small change shown as a diff in the brief. You cannot open files: judge the change from the diff and the brief. Check that it does what was asked, is correct, and breaks nothing next to it. Call submit_review once with a verdict and specific comments. Call block_task only if the diff cannot be judged.`,
      reviewer: `## Your task\nYou are reviewing a teammate's work. You do not edit files: you report what must change. Once you have checked the work, give your verdict with submit_review and stop; do not keep re-reading files.\n\n${REVIEW_STANDARD}`,
    chat: "## Direct chat\nThe developer is talking to you one-on-one. Answer as yourself, concisely and specifically, using your tools to look at the project when it helps. You cannot change files in this chat; suggest they ask the company in the main conversation for changes.",
    consult: "## A teammate's question\nA teammate needs a quick, precise answer from you. Look at the project if needed. Answer in a few sentences or a short list.",
  }[mode];
  const sections = [
    identity, own + extra, process,
    mode === "worker" || mode === "orchestrator" ? STANDARDS : "",
    p.skills.length ? `## Playbooks\n${p.skills.map((s) => `### ${s.name}\n${s.body}`).join("\n\n")}` : "",
    notes(p.memory.own, p.memory.shared),
    `## Team\n${roster(p.team, a)}`,
    `## Project\n${p.overview}`,
    "Formatting: Markdown. Be concise. Refer to files by their project path.",
  ];
  return sections.filter((s) => s.trim()).join("\n\n");
}

export function taskBrief(t: TaskOut, o: { goal: string; deps: TaskOut[]; team: AgentOut[]; feedback?: string; answer?: string }): string {
  const who = (id: string | null) => o.team.find((a) => a.id === id)?.name ?? "someone";
  return [
    `# ${t.key}: ${t.title}`,
    t.description,
    t.acceptance_criteria && `## Acceptance criteria\n${t.acceptance_criteria}`,
    `## The user's request (for context)\n${o.goal}`,
    o.deps.length ? `## Work this builds on\n${o.deps.map((d) => `### ${d.key} ${d.title} (${who(d.assignee_agent_id)})\n${d.result || "Done."}`).join("\n\n")}` : "",
    o.feedback ? `## Review feedback to address\n${o.feedback}` : "",
    o.answer ? `## The user's answer to your question\n${o.answer}` : "",
  ].filter(Boolean).join("\n\n");
}

export function reviewBrief(work: TaskOut, o: { goal: string; author: string; summary: string; files: string[]; round: number; diff?: string }): string {
  return [
    `# Review ${work.key}: ${work.title} (by ${o.author}${o.round > 1 ? `, revision ${o.round}` : ""})`,
    `## What was asked\n${work.description}`,
    work.acceptance_criteria && `## Acceptance criteria\n${work.acceptance_criteria}`,
    `## The user's request\n${o.goal}`,
    `## The author's summary\n${o.summary}`,
    `## Files changed\n${o.files.length ? o.files.map((f) => `- ${f}`).join("\n") : "(no files changed)"}`,
    o.diff && `## The change (small: judge it from this diff)\n${o.diff}`,
  ].filter(Boolean).join("\n\n");
}

export function libraryList(roles: RoleTemplateOut[]): string {
  return roles.filter((r) => r.key !== "orchestrator").map((r) => `- ${r.key}: ${r.role}. ${firstLine(r.description, 100)}`).join("\n");
}
