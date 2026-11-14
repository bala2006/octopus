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
You are a specialist sharpening a teammate's part. The brief names your lens (code, art direction, play testing or
security): judge through it, against the user's request and the acceptance criteria. Check, in order:
1. Does it meet each acceptance criterion and the user's request, as the user would see it? Anything missing?
2. Through your lens: correctness and edge cases; or how it looks against the user's words; or how it plays; or
   what can be abused.
3. Verification: run it, look at it, or play it when you can. Trust what you observe over the author's summary.
Approve work that is right; do not block on taste outside your lens. Request changes only for real problems, as a
numbered list: where, what is wrong, the concrete fix. Other specialists review the same round in parallel; the owner
gets everyone's comments together.`.trim();

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
   whole ask per item (never a fragment such as a single quoted word), not merged and not softened. The finished product
   is checked against them. Requirements describe the product, not how to work: "hurry", "finish fast", "serve it" or
   "I'll test it" are instructions to you, not requirements. Ambitious asks stay in: give a hard one to the right owner
   and specialist. Use cut_requirement only for what cannot be built in this environment, with the reason and what is
   delivered instead; the user sees every cut. A small fix needs no requirements.
4. Split the work into parts. Each part has one owner who builds it end to end and is the only one who writes its files.
   - A part is something that can be built and checked on its own: an app, a service, a library, a game. Never split
     one tightly connected artifact (one game, one page, one module) between builders: parallel writers make
     conflicting choices and the pieces do not fit. One owner writes it; quality comes from the specialists below.
   - Several parts only when they are truly independent, with an interface between them (a backend and a frontend
     over an API). Then the first task, for an architect or the first owner, builds the runnable skeleton and pins
     the interfaces (pin); the other owners depend on it and build against the pins.
   - Give each owner task the files or folders it owns.
5. Attach the specialists who sharpen each part (create_task specialists). They critique every round in parallel, each
   through their own lens, and the owner gets their feedback together:
   - an art director (role designer) for anything people look at: a UI, a game, a page;
   - a QA engineer (role qa) for anything people use or play;
   - a security engineer for authentication, payments or untrusted input.
   A code reviewer is added automatically. Choose specialists for what the user cares about most: when the request is
   about how something looks, the art director matters as much as the owner.
6. Side work that does not write the product, such as researching techniques or libraries, can be its own research
   task running in parallel; its result reaches the owner through depends_on.
7. Plan with create_task. Give each task: the objective, the files and interfaces involved, decisions already made,
   acceptance criteria that can be checked, the requirement ids it delivers, the files it owns, the skills its owner
   should follow, and its specialists. Order with depends_on. Never plan review, test or acceptance tasks: reviews
   by the specialists, the project's tests and the final acceptance check against the requirements are automatic.
8. Call start_work with a one-sentence plan for the user.
When the user writes while the team works, record new product asks with set_requirements and use amend_task on the task
that owns the change; create a task only for new work. When the work comes back you will be asked to report.`.trim();

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
    worker: "## Your task\nYou own this part. Build it completely and well, the way the user described it, not a reduced version. Before you finish, look at the result the way the user will (run it, open it, screenshot it) and fix what falls short; check each acceptance criterion with the cheapest check that proves it. Then call complete_task: specialists review your part next and their feedback comes back to you in this conversation, so do not polish endlessly. If you cannot do it as specified, call block_task with what you need. Message a teammate for facts only they have or to change something in their part; ask the user only for decisions only they can make.",
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

export function reviewBrief(work: TaskOut, o: { goal: string; author: string; summary: string; files: string[]; round: number; diff?: string; previous?: string; requirements?: Requirement[]; lens?: Lens; pins?: string[] }): string {
  const mine = (o.requirements ?? []).filter((r) => work.requirements.includes(r.id));
  const lens = LENS[o.lens ?? "code"];
  return [
    `# ${lens.title} ${work.key}: ${work.title} (by ${o.author}${o.round > 1 ? `, revision ${o.round}` : ""})`,
    `## Your lens: ${lens.name}\n${lens.how}`,
    `## What was asked\n${work.description}`,
    work.acceptance_criteria && `## Acceptance criteria\n${work.acceptance_criteria}`,
    mine.length && `## Requirements this work delivers (the user's words)\n${mine.map((r) => `- ${r.id}: ${r.text}`).join("\n")}`,
    o.pins?.length && `## Pinned in the team chat\n${o.pins.join("\n\n")}`,
    `## The user's request\n${o.goal}`,
    `## The author's summary\n${o.summary}`,
    o.previous && `## The previous review's comments\nCheck that each is resolved. Request changes only for unresolved comments or real problems in the work; do not start over.\n\n${o.previous}`,
    `## Files changed\n${o.files.length ? o.files.map((f) => `- ${f}`).join("\n") : "(no files changed)"}`,
    o.diff && `## The change (small: judge it from this diff)\n${o.diff}`,
  ].filter(Boolean).join("\n\n");
}

/** The next turn of a critic who already reviewed this work: only what changed since. */
export function reReviewBrief(work: TaskOut, o: { author: string; summary: string; files: string[]; round: number; diff: string; lens?: Lens }): string {
  return [
    `# Re-review ${work.key}: revision ${o.round} by ${o.author}`,
    `${o.author} revised the work after the last review round. Their summary:\n${o.summary}`,
    `## Changed since your review\n${o.files.length ? o.files.map((f) => `- ${f}`).join("\n") : "(no files changed)"}`,
    o.diff && `## The change since your review\n${o.diff}`,
    `Check that each of your comments is resolved, through your lens (${LENS[o.lens ?? "code"].name}), and that this change is correct. You already know the rest of the work: look again only where the change needs it. Request changes only for unresolved comments or real problems. Then call submit_review.`,
  ].filter(Boolean).join("\n\n");
}

/** What a critic looks at. A part's specialists each bring one; a code reviewer is always one of them. */
export type Lens = "code" | "visual" | "play" | "security";

export const LENS: Record<Lens, { title: string; name: string; how: string }> = {
  code: { title: "Review", name: "code review", how: "Read the change and the code around it. Judge correctness, edge cases, security, and fit with the codebase; run the tests or the program when you can." },
  visual: { title: "Visual review", name: "art direction",
    how: "Run the product (start_dev_server, then the browser) and screenshot the views that matter, driving it through its test hook where needed. Compare what you see with the user's own words, element by element. Request changes for anything missing, flat, placeholder-looking or wrong, in priority order, each with a concrete direction the owner can act on: the technique, the values, where in the code. Approve only when it looks like what the user described." },
  play: { title: "Play review", name: "play testing",
    how: "Use the product as the user would: every flow in the acceptance criteria and the requirements, then the edge cases (restart, pause, resize, wrong input). Drive real-time or pointer-locked apps through their test hook. Request changes with exact reproduction steps, expected and actual results." },
  security: { title: "Security review", name: "security review", how: "Look for injection, unsafe input handling, secrets, broken access control and risky dependencies in the change. Rank findings by severity with evidence and a concrete fix." },
};

/** The lens an agent critiques with, from its role. */
export function lensOf(agent: AgentOut): Lens {
  const role = agent.behavior.template_key ?? "";
  if (["designer", "ux_designer", "creative_director", "art_director", "game_designer"].includes(role)) return "visual";
  if (["qa", "qa_engineer", "playtester", "e2e_tester"].includes(role)) return "play";
  if (["security", "security_lead"].includes(role)) return "security";
  return "code";
}

/** One critic's verdict in a review round. `none` when it could not give one. */
export interface Verdict { critic: string; lens: Lens; verdict: "approve" | "request_changes" | "none"; comments: string }

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
