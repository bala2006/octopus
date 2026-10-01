# Plan: Octopus as a real software company

Goal: every run works like a well-run engineering org. Who takes the goal, who plans, researches, designs, builds,
tests, reviews and signs off is defined, enforced by the engine and visible to you, and the result is at least as good
as one strong agent working alone (measured, not assumed).

## Research this plan is built on

| Source | Finding | Used for |
|---|---|---|
| [MetaGPT (ICLR 2024)](https://arxiv.org/html/2308.00352v7) | Encoding Standard Operating Procedures (SOPs) into the workflow, with structured documents passed between roles, reduces compounding errors | Workflow phases with defined owners, inputs/outputs and documents instead of chat |
| [ChatDev (ACL 2024)](https://aclanthology.org/2024.acl-long.810/) | Chronological phases (design, coding, testing, documenting), each split into small, checkable subtasks | Phase order and per-phase exit criteria |
| [AgentCoder](https://arxiv.org/html/2312.13010v1) | An independent test designer plus a test executor feeding results back to the programmer beats single-agent baselines | QA writes tests from the spec, not from the code; failures loop back to the builder |
| [MAST, why multi-agent systems fail](https://arxiv.org/abs/2503.13657v2) | Failures cluster in specification, inter-agent misalignment and missing verification, and need structural fixes | Engine-enforced gates, not just prompts |
| [Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Parallel agents pay off on breadth-first, independent work; scale the effort to the task | Tracks (Quick / Standard / Large) and parallelism only inside a phase |
| [Cognition: Don't build multi-agents](https://old.cognition.ai/blog/dont-build-multi-agents) | Splitting work loses context; share the same sources and plan | Every phase owner gets the goal verbatim plus all earlier documents |
| [Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | A skill is a SKILL.md with name + description in the prompt; the full body is loaded only when relevant (progressive disclosure) | The skills format and loading |
| Nielsen's heuristics ([recognition vs recall](https://www.interaction-design.org/literature/topics/recognition-vs-recall)) | Choosing from visible options beats typing from memory; prevent errors; minimalist design | The mini window redesign |

## 1. The company workflow (who does what)

Every goal goes to the **company head**, and the head's job is narrow: take the goal in, pick a track, assign owners,
and sign off at the end. The head does not retell the goal. The engine passes your original message, images and files
verbatim to every phase owner.

| Phase | Owner (role) | Input | Output (document) | Exit gate (engine-checked) |
|---|---|---|---|---|
| 0. Intake | Head (CEO / Lead) | Your goal, attachments, project files, past runs | Track and owners on the Blackboard | Track chosen |
| 1. Research (only if there are unknowns) | Researcher | Goal | `.octopus/work/research.md`: facts, options, recommendation, sources | Document exists with a recommendation |
| 2. Spec | Product Manager | Goal, research | `spec.md`: scope, non-goals, **testable acceptance criteria** | Every criterion is checkable |
| 3. Design | Architect (+ UX Designer for UI work) | Spec | `design.md`: file/module plan, interfaces, data, UI states | Every acceptance criterion maps to a module |
| 4. Build | Engineer(s), one owner per module | Spec, design | The code | Automatic checks pass, and the builder ran or opened it (already built in PR #43) |
| 5. Test | QA (independent) | Spec (not the code) | Tests + `test-report.md` with repro steps | Tests executed; failures go back to the builder (at most 3 loops, then escalate) |
| 6. Review | Tech Lead, fresh context | Diff, spec, test report | `review_result` approve / request changes | Approved |
| 7. Accept | Head | All of the above | Final report: what shipped, evidence, open items | Acceptance criteria met with evidence |

**Tracks** keep small goals fast:
- **Quick** (fix, script, single file): Intake → Build → Test → Accept. The builder writes the acceptance criteria.
- **Standard** (feature, app): all phases; Research only if there are unknowns.
- **Large** (multi-part product): Standard, plus parallel builders per module from the design and integration testing.

**Engine support (new `orchestrator/workflow.py`):**
- Phase state per run.
- Phases start only when their inputs exist; transitions happen when exit gates pass.
- Handoffs are documents passed by path, not chat.
- Questions to you are allowed in Intake/Spec only (through the head).
- A progress bar of phases on the run page.
- Companies without a workflow keep today's free-form behaviour.

## 2. Skills (step-by-step playbooks)

**Format:** Agent Skills compatible. One `SKILL.md` per skill: YAML front matter (`name`, `description`, `when_to_use`,
`roles`, `phases`), then numbered steps, checklists and templates. The same file works in Claude Code, Codex and other
tools.

**Where skills live:**
- Built-in: `backend/app/skills/<name>/SKILL.md`
- Yours: registry (Settings → Skills)
- Per project: `.octopus/skills/`; existing `.claude/skills` and `.agents/skills` folders are read too

**Loading (progressive disclosure):**
- The prompt lists only the name and description of the skills attached to the agent's role or current phase.
- A native `use_skill(name)` tool loads the full body.
- The skill attached to the current phase loads automatically when the phase starts.

**Starter library:**

| Area | Skills |
|---|---|
| Product | write-spec, acceptance-criteria |
| Research | research-brief, compare-options |
| Design | technical-design, ux-spec, design-system |
| Engineering | implement-feature, frontend-web-app, backend-api, web-game (Three.js loop, input, assets, performance), cli-tool, refactor-safely, debug-failure (reproduce → hypothesis → isolate → fix → regression test) |
| Quality | write-tests-from-spec, browser-qa (flows, console, screenshots), performance-check |
| Review | code-review checklist (correctness, security, performance, readability), security-review (OWASP Top 10) |
| Delivery | write-readme, release-checklist |

## 3. Roles: a library, edited in Settings → Roles

- **A role** is: key, title, category, description, system prompt, default tools, default skills, default model/effort,
  behaviour, and the phases it owns.
- **Agents link to a role** through a first-class `role_key`. The prompt is resolved at run time and no longer copied
  into each agent, so editing a role updates every agent using it.
- **Per-agent tweaks** go in an "Additional instructions" field in the full inspector, appended to the role prompt.
- **Storage:**
  - Built-in roles stay in code.
  - Your edits and custom roles go in a new registry table `user_roles`, holding overrides or full custom roles.
  - **Restore default** deletes the override. "Restore all" is also available.
  - Resolution happens everywhere roles are used: canvas, templates, runtime hires, the AI org designer.
- **Settings → Roles UI:**
  - Searchable list grouped by category, with Built-in / Modified / Custom badges and how many agents use each role.
  - Editor: title, description, prompt with variable chips and a rendered preview, tools, skills, model/effort defaults.
  - Buttons: Duplicate, Delete (custom only), Restore default (with confirmation).
- **Migration, nothing breaks:**
  - Agents whose prompt equals their built-in role become linked to it.
  - Agents with an edited prompt keep it, as a per-agent custom prompt, with a "Switch to role prompt" action.

## 4. Agent mini window (canvas quick config), redesigned

Choose from lists instead of typing; only the name is typed. Rows in order:

1. **Name**: text.
2. **Role**: searchable list grouped by category, built-in + yours. Picking one switches prompt, tools and skills, with
   an *Undo* toast.
3. **Department**: list of departments, plus "New department…".
4. **Reports to**: list.
5. **Model**: one combined list ("Azure · gpt-6-luna").
6. **Thinking**: Auto / Low / Medium / High, with "more" for the rest.
7. **Permission**: list.
8. **Receives goal**: shown on the company head only.
9. **Active**: toggle.
10. **Tools**: a preset list (Role default / Builder / Reviewer / Researcher / Read-only / Custom), with MCP servers as
    chips. The full toggle grid moves to the inspector.
11. **Skills**: chips from the role, add from a list.

The system prompt is removed from the mini window and linked instead ("Edit in Settings → Roles"). The panel fits
without scrolling. The full inspector gets the same role list, a read-only resolved prompt and "Additional
instructions".

## 5. Templates rebuilt on the workflow, roles and skills

Fewer, better, each with a defined workflow, tracks, roles, skills and channels:

1. **Solo Builder**: one full-stack engineer with build, test, debug and browser-QA skills. This is the baseline.
2. **Builder + Reviewer**: engineer and tech lead (review + QA). The recommended default for coding.
3. **Product Team**: Head, PM, Architect, 2 Engineers, QA, Tech Lead. The full SDLC workflow, all three tracks.
4. **Web App Studio**: PM, UX Designer, Frontend, Backend, QA (browser), Tech Lead.
5. **Game Studio**: Game Director (intake + game design doc), Gameplay Engineer, Graphics/Tech Artist, Playtester QA.
6. **Bug Squad**: Triage Lead, Debugging Engineer, Regression QA.
7. **Research & Report**: Research Lead, parallel Researchers, Editor.
8. **Data / ML**, **Security Audit**, **Docs & Content**: rebuilt on the same model.

Old template keys stay resolvable as aliases, so existing companies and user templates keep working.

## 6. Proving it: the benchmark

`scripts/bench.py` with real models runs these tasks:
- a single-file Three.js game
- a REST API with auth
- a bug fix in an existing repo
- a refactor
- a research report

Each task runs on three templates: Solo Builder, Builder + Reviewer, Product Team. Results are scored on:
- hidden acceptance tests, plus browser checks for UI tasks
- tokens, time and cost

Release rule: a team template must score at least as well as Solo Builder on every task, and better on the large ones.
Defaults are set by these numbers.

## Delivery stages (one commit each, tests at every stage, nothing removed without a migration)

| Stage | What ships |
|---|---|
| S1 | Roles foundation: `role_key`, prompt resolved at run time, `user_roles` table + API, Settings → Roles (edit, create, restore defaults), migration of existing agents |
| S2 | Mini window redesign + inspector updates |
| S3 | Skills: format, loader, `use_skill`, built-in library, Settings → Skills, attaching skills to roles and phases |
| S4 | Workflow engine: phases, tracks, gates, document handoffs, independent QA loop, phase progress in the run page |
| S5 | Templates rebuilt on S1-S4, old keys aliased |
| S6 | Benchmark runs, then tuning of prompts, skills and defaults from the results |

## Status

Decisions taken (the recommended options): editing a role updates every agent linked to it; project skills are also
read from `.claude/skills` and `.agents/skills`; template keys stay stable, and every template reports whether its team
can run the workflow.

| Stage | Status |
|---|---|
| S1 Roles foundation | Shipped: `user_roles`, `/api/v1/roles`, Settings → Roles, linked prompts in runs and chat |
| S2 Mini window | Shipped: everything except the name is picked from a list; the prompt lives in the role |
| S3 Skills | Shipped: 18 built-in skills, `use_skill`, Settings → Skills, project skill folders |
| S4 Workflow engine | Shipped: `set_track`, phase owners, briefs, gates, test/review → build fix loop, workflow bar, report section |
| S5 Templates | Shipped: workflow readiness per template, Bug Squad, quick-track review fallback |
| S6 Benchmark | Ready to run: `python scripts/bench.py --projects-root <dir> --workflow on\|off` (adds a Three.js shooter task); needs a real model |
