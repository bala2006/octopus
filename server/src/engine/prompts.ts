/**
 * What agents are told. The quality bar lives here: one set of engineering and product standards for every builder,
 * a review standard for reviewers, and the orchestrator's operating procedure. Role prompts (catalog/roles.ts) only
 * describe the speciality.
 */
import type { AgentOut, MemoryOut, Requirement, RoleTemplateOut, SkillOut, TaskOut } from "@octopus/shared";
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
- Keep it readable: clear names, small functions, one responsibility each; comments explain why, not what. Keep files
  small (one module per concern, about 400 lines at most) so a teammate can read and change one part without the rest.
- Products feel finished: real copy (never lorem ipsum), accessible (labels, focus, contrast, keyboard), responsive, with
  loading, empty and error states. Match the user's own words for how it should look and behave, not a reduced version.
- Make it checkable: an interactive UI or game exposes a small test hook (for example window.__app with its state and
  actions) so browser automation can drive what a mouse or pointer lock would.
- Verify before you say it is done: run the build, the tests and the linters that exist; add or update tests for the
  behaviour you change when the project has tests; open UIs in the browser when you have one and check the console.
- Work in few steps: read or write several independent files in one step, do not re-read a file you just wrote, and
  when tuning visuals decide each change from one screenshot instead of nudging values one at a time.
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

const ACCEPTANCE_PROCEDURE = `
## Acceptance check
The team says the work is finished. You decide, for each requirement you are given, whether the user would agree. You
did not build it and you do not change it: you run it, look at it and report.
1. Run it the way the user would: start_dev_server and open the URL in the browser for anything with a UI; run the
   program or its tests otherwise. Read the console.
2. Check every requirement against the user's own words, not against the team's spec or summary. For anything visual,
   take a screenshot and judge what you see: placeholder shapes, missing effects, broken layout or a flow that does not
   work mean unmet.
3. When the browser cannot drive something (pointer lock, real-time input), use a test hook the app exposes, or a test
   that exercises it. If you could not observe it at all, it is unmet, and the evidence says what is needed to check it.
4. Be specific in evidence: what you did, what you saw, and for unmet ones what is missing.
Call submit_acceptance once with a result for every requirement. Do not keep exploring after you have an answer for each.`.trim();

const ORCHESTRATOR_PROCEDURE = `
## How you work
You are the head of a company of AI specialists working for one developer, in their project folder. Your job: understand
what they want, staff it, brief the team so well that nobody needs to ask, and make sure the result is what they asked for.

1. Understand. Read the request and the project overview. For a small, clear change (one file, one symptom), skip the
   exploration: name the file and the symptom in the brief and let the builder read the code. For larger existing code,
   look at the relevant files yourself (list_files, search_project, read_file) so your briefs name real files and real interfaces.
2. Decide what kind of turn this is.
   - A question, explanation or opinion that needs no project changes: answer with reply_to_user. Be direct and specific.
   - A real ambiguity where a wrong guess would waste most of the work: ask_user with 2-5 options, one recommended.
     Otherwise make the sensible choice and state it in the brief.
   - Work: continue below.
3. Record the requirements of a feature or product with set_requirements: every explicit ask, in the user's words, one
   per ask, not merged and not softened. The finished product is checked against them. Ambitious asks stay in: give a
   hard one its own task and the right specialist. Use cut_requirement only for what cannot be built in this environment,
   with the reason and what is delivered instead; the user sees every cut. A small fix needs no requirements.
4. Staff the smallest team that has the expertise: one builder for a fix, one or two for a feature. For a product:
   - Split the build into parts with separate owners working in parallel (for a game: world and lighting, enemies,
     weapon and effects, game loop and HUD). One builder writing a whole product produces a shallow one.
   - When the parts must fit together, first a design task for a tech lead or architect: the module layout, who owns
     which paths, and the interfaces between parts, in .octopus/work/. The builders depend on it.
   - A product manager or designer only when the requirements or the look are genuinely unclear; you write the
     requirements yourself. Never hire for show.
   - A QA engineer for anything with a UI or real-time interaction: they run the acceptance check.
5. Plan with create_task. One owner per deliverable. Give each task: the objective, the files and interfaces involved,
   decisions already made, acceptance criteria that can be checked, the requirement ids it delivers, the files or folders
   it owns (tasks that run in parallel own different paths), and the skills its owner should follow. Order with
   depends_on (a design before the builds that use it).
   Reviews, the project's tests and the acceptance check against the requirements are automatic: never plan tasks for them.
6. Call start_work with a one-sentence plan for the user.
When the user writes while the team works, record new asks with set_requirements and use amend_task on the task that
owns the change; create a task only for new work. When the work comes back you will be asked to report.`.trim();

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
export function instructions(p: PromptContext, mode: "orchestrator" | "worker" | "reviewer" | "quick_review" | "acceptance" | "chat" | "consult" | "report"): string {
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
    acceptance: ACCEPTANCE_PROCEDURE,
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

export function taskBrief(t: TaskOut, o: { goal: string; deps: TaskOut[]; team: AgentOut[]; feedback?: string; answer?: string; requirements?: Requirement[]; docs?: { path: string; content: string }[]; pins?: string[] }): string {
  const who = (id: string | null) => o.team.find((a) => a.id === id)?.name ?? "someone";
  const mine = (o.requirements ?? []).filter((r) => t.requirements.includes(r.id));
  return [
    `# ${t.key}: ${t.title}`,
    t.description,
    t.acceptance_criteria && `## Acceptance criteria\n${t.acceptance_criteria}`,
    mine.length && `## Requirements you deliver (the user's words; the finished product is checked against these)\n${mine.map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    t.files.length && `## Your part\n${t.files.map((f) => `- ${f}`).join("\n")}\nYou own these files. Teammates own the other parts: to change something in theirs, message them. Only a file a teammate is editing right now is closed to you.`,
    o.pins?.length && `## Pinned in the team chat (build on these; pin a new version if you must change one)\n${o.pins.join("\n\n")}`,
    `## The user's request (for context)\n${o.goal}`,
    o.deps.length ? `## Work this builds on\n${o.deps.map((d) => `### ${d.key} ${d.title} (${who(d.assignee_agent_id)})\n${d.result || "Done."}`).join("\n\n")}` : "",
    o.docs?.length ? `## Documents from that work (already here: do not read them again)\n${o.docs.map((d) => `### ${d.path}\n\`\`\`\n${d.content}\n\`\`\``).join("\n\n")}` : "",
    o.feedback ? `## Review feedback to address\n${o.feedback}` : "",
    o.answer ? `## The user's answer to your question\n${o.answer}` : "",
  ].filter(Boolean).join("\n\n");
}

export function reviewBrief(work: TaskOut, o: { goal: string; author: string; summary: string; files: string[]; round: number; diff?: string; previous?: string; requirements?: Requirement[] }): string {
  const mine = (o.requirements ?? []).filter((r) => work.requirements.includes(r.id));
  return [
    `# Review ${work.key}: ${work.title} (by ${o.author}${o.round > 1 ? `, revision ${o.round}` : ""})`,
    `## What was asked\n${work.description}`,
    work.acceptance_criteria && `## Acceptance criteria\n${work.acceptance_criteria}`,
    mine.length && `## Requirements this work delivers (the user's words)\n${mine.map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    `## The user's request\n${o.goal}`,
    `## The author's summary\n${o.summary}`,
    o.previous && `## The previous review's comments\nCheck that each is resolved. Request changes only for unresolved comments or real problems in the work; do not start over.\n\n${o.previous}`,
    `## Files changed\n${o.files.length ? o.files.map((f) => `- ${f}`).join("\n") : "(no files changed)"}`,
    o.diff && `## The change (small: judge it from this diff)\n${o.diff}`,
  ].filter(Boolean).join("\n\n");
}

/** The next turn of a reviewer who already reviewed this work: only what changed since. */
export function reReviewBrief(work: TaskOut, o: { author: string; summary: string; files: string[]; round: number; diff: string }): string {
  return [
    `# Re-review ${work.key}: revision ${o.round} by ${o.author}`,
    `${o.author} revised the work after your review. Their summary:\n${o.summary}`,
    `## Changed since your review\n${o.files.length ? o.files.map((f) => `- ${f}`).join("\n") : "(no files changed)"}`,
    o.diff && `## The change since your review\n${o.diff}`,
    "Check that each of your comments is resolved and that this change is correct. You already know the rest of the work: read a file again only where the change needs it. Request changes only for unresolved comments or real problems in this change. Then call submit_review.",
  ].filter(Boolean).join("\n\n");
}

/** The next turn of a session: why the work came back, and how to finish. */
export function revisionNote(t: TaskOut, why: { from: string; text: string }, finish: string): string {
  return [
    `# ${t.key} again: ${why.from}`,
    why.text,
    `What you read and wrote is earlier in this conversation; re-read only what changed since. ${finish}`,
  ].join("\n\n");
}

/** The first acceptance check of a cycle: the requirements, how to run the product, and what the team says it built. */
export function acceptanceBrief(o: { goal: string; requirements: Requirement[]; work: { key: string; title: string; who: string; result: string }[]; files: string[]; scripts: string }): string {
  return [
    "# Acceptance check",
    `## The user's request\n${o.goal}`,
    `## Requirements to check\n${o.requirements.map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    o.scripts && `## How to run it\n${o.scripts}`,
    `## What the team says it built\n${o.work.map((w) => `- ${w.key} ${w.title} (${w.who}): ${firstLine(w.result, 300)}`).join("\n")}`,
    o.files.length && `## Files changed\n${o.files.map((f) => `- ${f}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

/** A later acceptance check in the same session: only the requirements that failed, after the fixes. */
export function reAcceptanceBrief(o: { requirements: Requirement[]; fixes: { key: string; who: string; result: string }[] }): string {
  return [
    "# Acceptance check again",
    `The team worked on what you found:\n${o.fixes.map((f) => `- ${f.key} (${f.who}): ${firstLine(f.result, 300)}`).join("\n")}`,
    `## Check these again\n${o.requirements.map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    "Reload the product (restart nothing that is still running) and check only these. Then call submit_acceptance.",
  ].join("\n\n");
}

/** The part of the report the engine writes: every requirement with its status, and everything left open. */
export function outcomeSection(o: { requirements: Requirement[]; open: string[] }): string {
  const status = { open: "Not checked", met: "Met", unmet: "Not met", cut: "Left out" } as const;
  const cell = (s: string) => firstLine(s, 200).replace(/\|/g, "\\|");
  return [
    o.requirements.length && `### Requirements\n| | Requirement | Status | Notes |\n|---|---|---|---|\n${o.requirements.map((r) => `| ${r.id} | ${cell(r.text)} | ${status[r.status]} | ${cell(r.note)} |`).join("\n")}`,
    o.open.length && `### Still open\n${o.open.map((x) => `- ${x}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

export function libraryList(roles: RoleTemplateOut[]): string {
  return roles.filter((r) => r.key !== "orchestrator").map((r) => `- ${r.key}: ${r.role}. ${firstLine(r.description, 100)}`).join("\n");
}

export function skillList(skills: SkillOut[]): string {
  return skills.map((s) => `- ${s.name}: ${firstLine(s.description, 140)}`).join("\n");
}
