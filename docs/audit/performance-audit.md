# Octopus: performance, intelligence and token-efficiency audit

**Date:** 15 November 2026
**Subject:** `bala2006/octopus` (v2.0.0, `main`), TypeScript monorepo (`shared/`, `server/`, `web/`)
**Question:** why does the same model produce weaker work through Octopus than through a direct harness, at far higher
token and time cost — and what in the code causes it?

**Outcome:** the fixes for these findings, the measurements after them and the remaining limitations are recorded in
[`implementation-report.md`](implementation-report.md).

---

## 0. How this was investigated

| What | How |
|---|---|
| Execution path | Read every file on the path from the user's message to the final report: `engine/conversation.ts` (1415 lines), `engine/agent.ts`, `engine/prompts.ts`, `engine/collab.ts`, `engine/ownership.ts`, `llm/azure.ts`, `tools/*`, `catalog/*`, `workspace/overview.ts`, `safety/*`, `shared/domain.ts`. |
| Behaviour | Drove the real engine end-to-end through the repo's own HTTP harness (`server/test/fakeModel.ts`, a scripted Responses-API stand-in) and instrumented every request the engine made: count, size, tool count, which agent, which mode. |
| Defects | Wrote throwaway assertions against the shipped code (`kindOf`, `staffingError`, `buildTemplate`) — deleted afterwards; results in §2. |
| Limits | No Azure deployment or credentials, so **no live model was called**. Call counts, payload sizes and control flow are measured; *reasoning quality* and *wall-clock* are inferred from those and from reading the code, and are labelled as such. No production traces or cost logs were available. |

Everything marked **Verified** was reproduced in this environment. **Risk** means the code demonstrably does the thing,
but the quality impact is inferred. **Hypothesis** means it needs a live A/B to confirm.

Verification commands used (reproducible):

```bash
npm ci
cd server && npx vitest --run test/zz-audit-bench.test.ts   # instrumented harness (scratch, deleted)
```

The scripted model replies instantly, so **wall-clock time was not measured**; what it proves is how many times the
engine calls the model, with how much text, and in what order.

---

## 1. Executive diagnosis

Octopus does not have one bug that makes the model worse. It has **a process that runs at every opportunity and a
taxonomy that misclassifies the team**, and the two compound.

The five things that actually cost you, in order of impact:

1. **The org taxonomy is broken (verified, critical).** `kindOf()` returns `"lead"` for anyone flagged `is_manager`
   (`catalog/kinds.ts:19`), and team templates mark *builders and QA* as department leads
   (`catalog/templates.ts:55`). A `lead` is refused as a task owner (`kinds.ts:27`) and is silently dropped as a
   specialist (`conversation.ts:1188`) and as a verifier (`conversation.ts:1290`). Measured consequence: the shipped
   **"Solo Engineer" template has zero writers, so `create_task` can never succeed**; **"Web App Studio" has zero
   critics, so the designer and QA the orchestrator attaches are discarded without an error**; **"Software Startup"'s
   QA can never run the acceptance check**, so a new QA is hired every cycle. Users picking a template get a run that
   does nothing — and is reported as *completed*.

2. **The pipeline is mandatory and runs on every request (verified, high).** Every user message goes through a
   stateless planner turn, then a worker session, then one critic per specialist plus an auto-hired tech lead, then the
   project's full test/typecheck/lint, then a separate acceptance agent, then a separate report call. Measured: a
   **one-line, one-file change costs 6 model calls**; a three-line page with one review round and one failed acceptance
   costs **16 calls**; add a designer and a QA and it is **21 calls** for the same three lines. A direct harness with
   the same model does that work in 3–4 calls.

3. **Every request starts cold (verified, high).** `finishCycle` calls `this.sessions.clear()`
   (`conversation.ts:1407`), and the planner never keeps a session at all. So each follow-up re-pays the whole prefix
   and re-reads files it wrote minutes ago: measured, "make the hero bigger" after a successful build is **6 more
   model calls including a `read_file` of the file the same agent wrote**. This is exactly the "re-reads files it
   already has" symptom.

4. **Fixed overhead is ~4–5k tokens per call, on every call (verified, high).** Measured per-call instruction blocks:
   orchestrator **12.7k chars**, worker **9.9k**, reviewer **9.6k**, quick diff review **8.9k**, acceptance **9.7k**,
   report **12.7k**, plus **7.5–9k chars of tool JSON schema** per call. A one-paragraph report gets the full 3.9k-char
   orchestrator operating procedure, the whole team roster and the project overview. A three-line diff review gets the
   full review standard and the same roster.

5. **Nothing escalates and nothing is honest at the end (verified, critical).** When the same tool call fails
   identically the loop only nudges at repeats 3, 5 and 8 (`agent.ts:56`, `agent.ts:188`) and will happily spend the
   whole 30-round planning budget; measured: **30 model calls, the same failing call, then the run was reported
   `completed` with the requirement still `open` and no files written**. `report()` only treats `unmet` requirements as
   blocking (`conversation.ts:1390`), never `open`, and `criticsFor` drops misclassified specialists without telling
   anyone.

Below the top five, the audit found a long tail of concrete waste (context compaction that mutates the cached prefix,
uniform `high` reasoning effort on every call including one-paragraph reports, tool outputs capped at 40k characters,
a linear full-text `search_project` with no dedupe, a findings gate that costs 1–2 extra turns per round, dead
config knobs). All of it is listed, ranked, with locations and fixes, in §3.

**The good news:** the foundations are sound. This is not a rewrite. Octopus already uses the native Responses API with
streaming and native function calling, keeps a stable prompt prefix per session, continues sessions across review
revisions (the single best design decision in the codebase), deduplicates unchanged reads, guards writes behind a
prior read, and models ownership explicitly. The waste is in *policy and orchestration*, not in the plumbing — which is
why the roadmap in §5 is mostly deletion and re-routing, not new machinery.

---

## 2. Execution lifecycle as implemented

```
user message
  │
  └─ drive()                                       conversation.ts:741
       ├─ plan(msg)                                :858   maxRounds 30      → 2 calls measured
       │    fresh session each turn (no `session`), instructions rebuilt (projectOverview walk),
       │    input = history digest (12 msgs × 3000 chars) + requirements + tasks
       │            + FULL role library + FULL skill list + limits
       │    tools: hire_agent, set_requirements, cut_requirement, create_task, amend_task,
       │           start_work, reply_to_user, ask_user, list/read/search, web  (15 tools)
       │    ends on reply_to_user | ask_user | start_work
       │
       ├─ execute()                                 :952
       │    for each ready task: runTask()          :1004
       │      ├─ worker session  (≤150 steps)       STEPS :98
       │      │    tools: 17   instructions ≈ 9.9k chars
       │      │    ends on complete_task | block_task | ask_user
       │      │
       │      ├─ settle() → critics               :1102
       │      │    criticsFor(): specialists (kindOf === "critic" only) + reviewerFor() auto-hire
       │      │    each critic: own session, ≤60 steps, own lens prompt, full task spec re-sent
       │      │    code lens + small diff  → quick_review (2 tools, 3 steps)   :123
       │      │    visual/play/security    → reviewer   (11–13 tools, 60 steps)
       │      │    round closes → all feedback merged → owner revision turn (same session, 1–2 revs)
       │      │    → re-review each critic (session continued, diff only)
       │      │    → open blocker/major findings gate the owner's complete_task (up to 3 tries)
       │      │
       │      └─ next task / dependency wakeups, agent↔agent messages (each = a full answer turn)
       │
       ├─ verify()                                  :1239
       │    runChecks(): project test + typecheck + lint, ≤4 scripts × 300 s   :1252
       │      failure → new fix task owned by last author → more worker calls
       │    requestAcceptance(): requirements still open/unmet? → verify task
       │      verifierFor(): QA else browser-capable critic else hire a QA   :1288
       │      acceptance session ≤60 steps, dev server + browser + screenshots
       │      unmet → fix task per owning part → worker calls → re-acceptance
       │
       └─ report()                                  :1359   1 call, no tools, full orchestrator prompt
            engine appends the requirement table + everything still open
            finishCycle(): sessions.clear()        :1407
```

**Calls per phase, measured** (scripted model, stock scripts, small project):

| Scenario | Model calls | of which plan | work | review | acceptance | report |
|---|---|---|---|---|---|---|
| Question, no code changes | **1** | 1 | – | – | – | – |
| One-line page (`write_file`), defaults | **6** | 2 | 2 | 1 | – | 1 |
| Same, `review:false, verify:false` | **5** | 2 | 2 | – | – | 1 |
| Same, project has test+typecheck scripts | **6** | 2 | 2 | 1 | – | 1 |
| Three-line page, 1 review round, 1 acceptance failure | **16** | 2 | 10 | 2 | 1 | 1 |
| …plus a designer and a QA as specialists | **21** | 3 | 10 | 6 | 1 | 1 |
| Follow-up "make the hero bigger" on the finished run | **6** | 2 | 3 | – | – | 1 |

**Per-call payload, measured** (same runs; chars, not tokens):

| Scenario | Instructions, total | Request input, total | Tool schemas per call |
|---|---|---|---|
| Question | 9k | 4k | 8.9k |
| One-line page | 41k | 12k | 7.5k |
| 16-call scenario | 98k | 41k | 8.1k |
| 21-call scenario | 129k | 52k | 7.9k |
| Follow-up | 42k | 12k | 9.0k |

**Static instruction size per mode**, measured against this repository as "the project" (overview 3.9k chars):

| Mode | Instructions | ≈ tokens | Largest blocks |
|---|---|---|---|
| orchestrator / report | 12.7k chars | ~3.5k | operating procedure 3.9k, README 1.6k, 3 playbooks 3.0k |
| worker | 9.9k | ~2.8k | playbooks 3.0k, README 1.6k, writer standard 0.7k |
| reviewer | 9.6k | ~2.7k | playbooks 3.0k, README 1.6k, review standard 0.9k |
| quick_review (diff only) | 8.9k | ~2.5k | playbooks 3.0k, README 1.6k, review standard 0.9k |
| acceptance | 9.7k | ~2.7k | playbooks 3.0k, README 1.6k, acceptance procedure 1.1k |
| consult (one-sentence answer) | 8.7k | ~2.4k | playbooks 3.0k, README 1.6k |

---

## 3. Findings, ranked by impact

Each finding has: what is wrong, where, how it shows up, impact, severity, why it happens, the fix, the expected gain and
what the fix could break. **Verified** = reproduced here. **Risk** = code does this, quality impact inferred.
**Hypothesis** = needs a live A/B.

### F1 — Team taxonomy makes builders unassignable and specialists invisible · **Critical · Verified**

**Issue.** Agent aptitude for *doing work* is derived from the org chart flag `is_manager`, not from what the agent can
actually do.

- `catalog/kinds.ts:19` — `if (agent.is_manager) return "lead";` (first thing `kindOf` does).
- `catalog/templates.ts:55-57` — every department lead is created with `manager: true`, including builders and QA:
  Solo Engineer's only developer, Web App Studio's designer and QA, Software Startup's architect and QA,
  Full Company's marketing lead.
- `catalog/kinds.ts:27` — `staffingError` refuses any owner whose kind is not `writer`.
- `conversation.ts:1188` — `criticsFor` keeps only specialists with `kindOf(a) === "critic"`, **silently**.
- `conversation.ts:1290` — `verifierFor` pools only `kindOf(a) === "critic"`.

**Evidence (measured).**

| Template | writers | critics | leads | Consequence |
|---|---|---|---|---|
| Solo Engineer | **0** | **0** | 2 | `create_task` always fails: *"Alex is not a writer, so cannot own a part."* |
| Small Dev Team | 2 | 0 | 2 | works (builders are plain members) |
| Software Startup | 3 | 1 | 4 | QA (lead) can never verify → a new QA is hired every cycle |
| Web App Studio | 2 | **0** | 4 | designer + QA attached as specialists are dropped with no error |
| Full Company | 6 | 4 | 5 | designer/QA/marketing lead lose their specialties |

Reproduced end-to-end on Solo Engineer: `create_task` rejected, the planner retried the same sequence to its 30-round
limit, and the run finished `completed` with `R1: open`, zero tasks and zero files.

**Impact.** For a large share of shipped starting points, the product either cannot start work or silently loses the
specialists the user picked the template for. It also degrades quality invisibly: the orchestrator believes an art
director is reviewing the page; nobody is.

**Root cause.** `kindOf` encodes *authority* (`is_manager`) where it means *capability* (`tools.file_write`, template),
and the templates conflate "leads a department" with "cannot produce work". A tech lead who reviews and a frontend
lead who builds are treated identically.

**Fix.** Make kind capability-derived and authority separate:

```ts
// kinds.ts
export function kindOf(agent) {
  if (agent.tools.file_write === false && agent.behavior.template_key !== "orchestrator") {
    return isReviewer(agent.behavior.template_key) ? "critic" : "lead";   // reads, runs, judges
  }
  return agent.tools.file_write === false ? "lead" : "writer";
}
/** Who may review this writer's work: capability, not org position. */
export const canReview = (a) => a.tools.file_read !== false && a.tools.file_write === false;
export const canVerify = (a) => canReview(a) && (a.tools.terminal || a.tools.browser);
```
and replace `kindOf(s) !== "critic"` in `staffingError`, `criticsFor` and `verifierFor` with `canReview` / `canVerify`.
`is_manager` keeps controlling *who reviews whom* and *who may plan*, nothing else.

**Expected improvement.** Solo Engineer and Web App Studio become usable (0 → working writers). No more phantom
specialists: the plan that says "designer reviews the page" actually runs one. Removes the 30-call spin.

**Regression risk.** Managers that today are excluded from writing would become eligible owners — that is the intent,
but any UI that assumes `is_manager ⇒ never writes` must be checked. Default roles' tool flags are already correct, so
`canReview(a)` must keep excluding writers (the designer role has `file_write: false`; a developer-lead has `true`).
Add unit tests over every built-in template: `writers ≥ 1`, `critics ≥ 1`, `canVerify ≥ 1`.

---

### F2 — A failing loop spins to its budget and the run is still reported as completed · **Critical · Verified**

**Issue.** Three separate defects meet: no escalation on repeated failure, a huge planning budget, and a status
computation that cannot see undelivered requirements.

- `agent.ts:56` `REPEAT_REMINDERS = [3, 5, 8]`, `agent.ts:188` — a generic nudge *only* at those counts, then silence.
  The nudge does not name the failing tool, the error, or an alternative.
- `agent.ts:147` — the wrap-up reminder only fires at `maxRounds - 4`, i.e. round 146 for a worker, 26 for a planner.
- `conversation.ts:922` — planner `maxRounds: 30`.
- `conversation.ts:1389` — `blocked` is computed from `unmet` requirements only; `open` requirements never make a run
  incomplete.

**Evidence.** Instrumented Solo Engineer run: `create_task` fails every round (because of F1 — but the loop behaviour is
the same for *any* persistent error: a wrong path, a rejected approval, a schema mismatch), `set_requirements` is
re-called, the model makes **30 requests** (252k chars of instructions, 347k chars of input, ~$0.001 at list rates on a fake 100-token
usage) and the result is `status=completed`, `R1: open`, no tasks, no files. The user's report says the work is done.

**Impact.** Unbounded token burn on any persistent tool failure (bad assignee name, missing file, wrong schema,
rejected approval), followed by a false success. This is the worst combination in the system: maximum cost, minimum
honesty.

**Root cause.** The loop treats "the model stopped producing useful calls" as a matter of style (a reminder), and the
run status is derived from requirement *verdicts* rather than requirement *coverage*.

**Fix.**
1. In `agentLoop`, key on a failure signature `name + args + error`, not on identical arguments alone. Two identical
   failures → push a specific message naming the tool, the error text, and one alternative (a different tool, a
   teammate, `block_task`). Three → return `{ exhausted: true, stop: {kind:"block", reason} }` immediately; do not
   spend the budget.
2. Track consecutive failures per turn and abort at 5 regardless of tool identity.
3. Make the planner budget adaptive: 2 rounds when no tool has failed, and end the turn on the first "nothing changed"
   round.
4. Fix the status: a run is `incomplete` when any requirement is `open` **or** any task is `blocked`, and the report
   must say "nothing was built" when no task was created.

**Expected improvement.** A hopeless turn ends in 3–5 calls instead of 30 (≈85% saving on that turn), and the report
stops claiming success. In the measured scenario the user would have seen a failure in ~2 seconds of token spend.

**Regression risk.** A legitimate retry after fixing the cause must still be allowed: signature-based escalation keys
on the *error*, so a call that starts succeeding resets the counter. `block_task` semantics for critics/verifiers already
exist (`criticFailed`) and should be reused rather than bypassed.

---

### F3 — Fixed per-call overhead of 4–5k tokens, identical in every mode · **High · Verified**

**Issue.** One prompt builder serves seven very different jobs, so a one-sentence answer, a three-line diff review and
a one-paragraph report all carry the full standard, the full playbooks, the full roster and the project overview.

- `engine/prompts.ts:113-137` — `instructions()` concatenates: identity, role prompt, mode procedure, writer standard,
  **up to 3 whole playbook bodies**, notes (up to 40 entries), **the entire active roster**, **the project overview**
  (layout, dependencies, up to 20 scripts, up to 40 README lines), and a formatting line.
- `catalog/skills.ts:40` — `skillsFor` returns up to 3 skills, injected whole (0.9–3.8k chars each).
- `workspace/overview.ts:60` — `projectOverview` walks up to 2000 files and re-reads `package.json`/README on every
  session creation.
- `tools/types.ts:112-115` — every tool schema is serialised per call: **7.5–9k chars** for 15–17 tools.

**Evidence.** Question-only run: **1 call, 8.9k chars tool schemas + 9k chars instructions** to answer "what does this
project do?". Quick diff review (`quick_review`, 2 tools): **8.9k chars** of instructions. Report turn: **12.7k chars**
for one paragraph, including the 3.9k-char orchestrator procedure it does not execute.

**Impact.** ~2.5k tokens of instructions + ~2.2k tokens of schemas on every call. Within one session this is mostly
cached, but every *new session* (planner turn, each critic, acceptance, report, every follow-up) pays it in full, and
it is the first thing on the bill for a one-call question.

**Root cause.** Prompt text was written as documentation of the whole system (it reads well), then wired in as one
string per mode. There is no notion of "the minimum this role needs for this turn".

**Fix.** Split into layers and include by need:
- **core** (~600 tokens): identity, honesty rules, edit/verify discipline, formatting.
- **capability card** per mode (~200–400 tokens): worker / quick_review / report / consult each get their own short card.
- **playbooks on demand**: replace whole-body injection with `- name: description` plus a `read_playbook(name)` tool.
- **project map**: engine-maintained, cached by directory mtime, and only for modes that touch code (never report,
  never quick_review).
- **roster**: only the people this turn can talk to (manager, direct reports, task specialists), not all 16.
- **tool schemas**: expose 6–10 tools per mode (already partly true) and drop the write tools from `quick_review`
  (already true) and from `report` (already true).

**Expected improvement.** Instruction block from 8.9–12.7k chars to ~2–3k for workers and ~1k for review/report/consult;
≈60–80% off the fixed part of every call, and the same saving again on tool schemas for small modes.

**Regression risk.** Playbooks currently shape behaviour (e.g. `web-game.md`); moving them behind a tool risks the
model not reading them. Mitigate by keeping the *first three lines* of each relevant playbook inline plus the tool, and
by measuring adherence in the benchmark suite (§6) before/after.

---

### F4 — The full review/verify/acceptance pipeline runs on every request · **High · Verified**

**Issue.** Process intensity is unconditional. There is no path from a one-line change to one agent and one call.

- `conversation.ts:1165` — every build/fix task that changed a file goes to `status: "review"` and spawns one review
  task **per specialist**, plus `reviewerFor()` which **hires a Tech Lead** if none exists (`:728`).
- `conversation.ts:1239-1301` — after every cycle: project checks, then an acceptance task judged by a *separate*
  agent, with a QA auto-hired when the pool is empty (`:1288`).
- `conversation.ts:1359` — a separate report call every cycle.

**Evidence.** Measured: one-line page = 6 calls (plan 2, work 2, review 1, report 1) and a **Tech Lead hired for a
one-line diff**; three-line page with one review round + one failed acceptance = **16 calls**, worker alone 10; with a
designer and a QA attached = **21 calls**, of which **6 are reviews** (each critic reviews round 1 *and* the revision).

**Impact.** This is the main multiplier behind "too many calls for straightforward tasks": 3–7× the calls of a single
delegated loop, each one carrying a fresh ~9k-char session and high-effort reasoning. It also delays the user: every
review round and acceptance round is serialised behind the previous one.

**Root cause.** The README's promise ("every change is reviewed by someone other than its author and checked with your
project's own tests") was implemented as a *phase machine for all work*, instead of a *service selected by risk*.

**Fix.** Introduce a risk router before `settle`:

```
risk = f(files changed, lines changed, touches tests/config/deps, UI?, security-sensitive path?, requirements?)
  trivial  → no review; worker self-verifies; report = worker's own complete_task text
  small    → one code review from the diff only (no session, no tools, ~1k-token prompt)
  normal   → one reviewer + the project's checks; acceptance only if requirements exist
  high     → specialists + acceptance (today's behaviour)
```
Gate the whole pipeline on `budget.review`/`budget.verify` *and* on this risk level, and let the orchestrator raise it
when it says the work matters. Replace the separate report call with the worker's `complete_task` summary plus the
engine-written requirement table (which is already appended, `outcomeTable`).

**Expected improvement.** One-line change: 6 → 2–3 calls. Small feature: 16–21 → 5–7. Acceptance and specialist review
remain for work that warrants them, so quality is preserved where it is measurable.

**Regression risk.** The product's differentiator is review coverage; a bad router silently lowers quality. Keep the
default at `normal` for existing conversations, log the chosen tier as a run event so it is visible, and let the user
pin a tier per message ("review this carefully").

---

### F5 — Sessions are destroyed at the end of every request, so follow-ups start cold · **High · Verified**

**Issue.** `finishCycle` clears every live session (`conversation.ts:1407`), and the planner never has one. A follow-up
therefore has no memory of files read, decisions made, or the code it just wrote.

**Evidence.** Two-message conversation on a finished run: message 2 ("make the hero bigger") = **6 calls** — 2 plan
calls that re-derive the plan from a 12-message history digest, a worker turn that begins with
**`read_file` on the file it wrote in message 1**, then edit, then complete, then a report call. The planner's input
for that one-line follow-up was 10k chars.

**Impact.** Exactly the reported symptom: re-reading unchanged files, re-analysing the same code, re-explaining the
plan. Cost is paid on *every* follow-up, which is the dominant mode of real use.

**Root cause.** Sessions were modelled as "work on one deliverable" and deliberately dropped at cycle end, with a
size cap and a brief as the fallback (`ARCHITECTURE.md` documents this). That is safe for correctness and expensive
for cost.

**Fix.**
- Key sessions by `(agentId, workspace)` and keep them across cycles, bounded by `SESSION_MAX_CHARS` (already exists,
  `:93`) with eviction *only* by size and by external file change.
- Give the orchestrator a persistent session per conversation, seeded once and continued for every plan turn (its
  input already contains everything; it just re-pays it).
- On external change, invalidate per file: the engine already tracks `seen`/`shown` hashes per session, so compare
  against the file's current hash and drop only what changed.
- Keep a cheap, append-only `history` digest in developer context, but stop re-sending the role library and skill list
  every turn (send them once per session; they are static).

**Expected improvement.** Follow-up "make the hero bigger": 6 → 2 calls, no re-read. Planner turns stop re-sending
~6k chars of static catalogue. Prompt caching starts working across the conversation instead of within one cycle.

**Regression risk.** Stale context after the user edits files by hand — mitigated by hash invalidation, which is the
same mechanism the engine already uses for change notices (`collab.fileChanged`). Long-lived sessions grow; the size
cap plus compaction already handles that (see F6 for the compaction fix).

---

### F6 — Context compaction mutates the cached prefix and then forces full re-reads · **High · Verified (mechanism) / Risk (quality)**

**Issue.** When the transcript grows, the engine rewrites *history in place*, and then declares every file "unseen".

- `agent.ts:67-95` `truncate()` — walks the transcript and **overwrites** older `function_call_output` items with
  `… [shortened to save context; run the tool again if you need it]`.
- `agent.ts:151-156` — threshold check, then `summarize()`, then `truncate()`, and on either, `o.ctx.shown.clear()`.
- `agent.ts:101-113` `summarize()` — asks the model to write a checkpoint over the *whole* transcript (a full-input
  call) and splices it into the middle of the session's own array.
- `conversation.ts:93` — a session over 600k chars is deleted, so the next turn starts from a brief.

**Impact.** Three costs. (a) The exact moment the context is largest, the prefix is rewritten, so provider prefix
caching is invalidated from that point on. (b) `shown.clear()` guarantees the agent re-reads files it already has — the
"reads files repeatedly" symptom, now caused by the engine rather than the model. (c) A checkpoint is lossy by
construction: interfaces, error text and partial diffs that mattered get summarized away, which is precisely when long
tasks need them. This is a quality risk with no measurement available here (needs a long live run).

**Root cause.** Compaction was designed to bound tokens, and it does — by destroying the two things that make long
sessions cheap and accurate: the stable prefix and the file-content ledger.

**Fix.**
- Never mutate items already sent. Emit a new, shortened transcript array at call time (`projection` of the session),
  keeping the session itself append-only. Cache-friendly and reversible.
- Compact **once**, at a high-water mark, into a structured checkpoint that the **engine** builds (task, requirements,
  files changed with hashes, open findings, last errors) and the model only *annotates*; keep the last N whole steps.
- On compaction, keep `shown` for files whose hash still matches (the content is in the checkpoint as a hash, not the
  file) and re-read lazily only when the model asks.
- Prefer evicting *tool outputs of finished steps* over rewriting reasoning and messages.

**Expected improvement.** Prefix caching stays valid for the whole turn; a long task stops paying for redundant reads;
checkpoints keep the facts that matter. Estimated 10–25% of input on long turns, plus accuracy.

**Regression risk.** A projection layer must not reorder items (function_call must precede its output) — the existing
`keptFrom()` already encodes that rule and should be reused. Summarisation tests in `agent.test.ts` cover the splice;
they will need updating.

---

### F7 — Uniform `high` reasoning effort on every call · **High · Verified**

**Issue.** One effort setting governs planning, building, a three-line diff review, a one-paragraph report and a
one-sentence teammate answer.

- `config.ts:37` — `defaultEffort: "high"`.
- `engine/org.ts:38`, `web/src/stores/canvas.ts:213` — agents are created with `reasoning_effort: "default"`, which
  falls through to the global default.
- `conversation.ts:488` — `effort()` = run budget → agent → `config.defaultEffort`; there is no mode dimension.
- `azure.ts:85` — the resolved effort is sent with `summary: "auto"` for every request.

**Impact.** Reasoning tokens are billed as output and replayed as input on subsequent steps (see F15). Paying `high`
to review a diff, write a paragraph, or reply "sent" is pure cost and latency; it also *adds* tokens to trivial turns,
which is how "verbose for no reason" happens. Conversely, one global setting cannot give the planning turn more depth
without giving every call more depth.

**Root cause.** Effort was modelled as a per-model/per-agent property, but the unit that actually varies is the *turn*.

**Fix.** A mode table, overridable per agent:

```ts
const EFFORT: Record<Mode, Effort> = {
  orchestrator: "high", worker: "high", acceptance: "medium",
  reviewer: "medium", quick_review: "low", report: "low", chat: "low", consult: "low",
};
```

Also drop `reasoning.summary` for `low`/`none` modes (`azure.ts:86`), and surface the effective effort in the run event
so cost is explainable.

**Expected improvement.** Typical measured scenario: 3 review calls + 1 report call + acceptance at medium/low instead
of high — an estimated 30–50% off output tokens for the pipeline parts, with no loss on the build. Faster reviews.

**Regression risk.** Lower effort on review can reduce finding quality. Keep `reviewer: medium`, and measure review
recall against a fixed seeded defect set in the benchmark before adopting.

---

### F8 — The orchestrator is a stateless, lossy hop between user and worker · **Medium · Verified**

**Issue.** The lead plans in a fresh session each turn and hands work over as a text brief. Everything it learned is
discarded, and the worker must rediscover it.

- `conversation.ts:922` — `plan()` calls `turn()` **without** `session`, so no transcript is kept; `instructions` are
  rebuilt (project overview walk) every time.
- `conversation.ts:820-840` — planner input is a *digest*: last 12 messages clipped to 3000 chars, task list, full role
  library, full skill list, limits.
- `prompts.ts:141` `taskBrief()` — the worker receives description, acceptance criteria, requirements, files, pins,
  dependency results, then the raw goal again.
- `prompts.ts:113` — the lead is also told to "look at the relevant files yourself" for larger code, and then that
  reading is thrown away at the end of the turn.

**Impact.** Double work (lead reads, worker re-reads), plan drift on follow-ups (the digest loses why decisions were
made), and one extra model call per user message at 8.5k chars of instructions. It is the structural reason a
"small, clear change" still costs two sessions.

**Root cause.** Sessions were designed for deliverable work only; the lead's conversation is reconstructed from the
database each time.

**Fix.** Keep the lead's session for the life of the conversation (F5), and let its brief be a *reference* — "T3: see the
files you read in your last step" — because the worker still needs its own view. Narrow the planner input: send the role
library and skill list once per session, and replace the 12-message digest with the persisted `history` only when the
session is new.

**Expected improvement.** One fewer re-payment of the planner prefix per message; fewer planner calls when a follow-up
is a clarification (the session already has the context).

**Regression risk.** A long-lived lead session accumulates stale beliefs about the code. Mitigate with the same hash
invalidation and with an explicit "the files changed since you last looked" note (the mechanism exists).

---

### F9 — Review packets re-send the whole task, and critics each pay a fresh session · **Medium · Verified**

**Issue.** Each critic gets the full spec, the goal, all requirements, pins and the author's summary *plus* the diff
— in a **new** session — even for a second critic reviewing the same three lines.

- `prompts.ts:159-180` `reviewBrief()` — full description, acceptance criteria, requirements, pins, goal, summary,
  files, optional diff.
- `conversation.ts:1186-1196` — one review task per specialist, each a fresh session (`reviewer` mode, ≤60 steps,
  11–13 tools for visual/play).
- `prompts.ts:184` `reReviewBrief()` is much better (diff only) but only applies to round 2+.

**Evidence.** 21-call scenario: 6 review calls carrying **31k chars of instructions** and 7k chars of input for a
three-line file.

**Impact.** Review cost scales with (critics × rounds × full spec), not with the size of the change.

**Fix.** Build a single *review packet* per round (diff + acceptance criteria + requirements + the file list) and send
the same packet to every critic behind a short lens prefix; use `quick_review` (no tools, ~1k-token prompt) whenever the
change is a diff-sized change regardless of lens, and only escalate to a tools-enabled reviewer when the lens genuinely
needs to run the product. Cap visual/play reviews to one per part per requirement set.

**Expected improvement.** Review instructions ~5k → ~1.2k chars per critic; a 2-critic round from ~10k to ~4k
instructions, and from 2 sessions to a shared packet.

**Regression risk.** A shared packet could leak one critic's opinion into another; keep them separate sessions but
identical packets. Visual review genuinely needs tools — keep the escalation rule explicit.

---

### F10 — File tools encourage large reads and rescan the repo linearly · **Medium · Verified**

**Issue.** The read ceiling is the size of a small book, and search is a full-text scan with no memory.

- `tools/types.ts:40` — `MAX_TOOL_OUTPUT = 40_000` chars ≈ 10k tokens, per tool result.
- `tools/files.ts:37-40,66-76` — `read_file` pages *to* that ceiling by default; a whole file is returned unless the
  caller passes a line range.
- `tools/files.ts:96-107` — `search_project` walks up to 4000 files, reads **every** file under 1 MB in full, and
  returns ≤120 matching lines; it keeps no index and no result cache.
- `tools/files.ts:78-85` — `read_file` dedupes unchanged re-reads (good), but `search_project` has no equivalent, so
  repeating a search re-emits the same 120 lines.

**Impact.** One read can be 10k tokens; a symbol re-search costs the same as the first. There is no symbol/outline tool,
so the model has no cheap way to orient and defaults to reading whole files.

**Root cause.** The tools were built for correctness (paging, binary/secret/generated guards), not for minimal context.

**Fix.** Default `read_file` page ≈ 12k chars with an explicit "continue at line N" and a `symbols`/`outline` tool
(function/method/class names + line ranges, engine-generated by regex per language); make `search_project` cache
`(query, path, mtime)` results per session and return at most ~40 hits with "narrow with `path`"; add a `grep -n`-style
`files_only` mode for existence questions.

**Expected improvement.** Estimated 40–60% fewer chars pushed into context per exploration step; fewer repeat reads
because the outline answers "where is X" without a read.

**Regression risk.** Smaller pages can cost an extra round trip when a file is genuinely needed whole; mitigate with an
explicit `full: true` escape hatch and by keeping the page boundary on line breaks.

---

### F11 — Findings gate adds turns and can block a finished task · **Medium · Verified**

**Issue.** After a revision, the owner must answer every blocker/major finding *by id* through `complete_task`; the
engine refuses the completion otherwise, up to three times.

- `conversation.ts:1145-1172` — `if (open.length || answered.unknown.length)` → write a resume note, set the task back
  to `todo`, increment `gate_tries`; at 3, `blocked`.
- `tools/team.ts` `complete_task.responses` — an array of `{id, status, response}`.

**Evidence.** Measured worker turn in the 16-call scenario: 10 calls, including `write_file` → *"index.html already has
this content."* (a wasted step caused by the script re-issuing a write) and two gate turns. When the script did not
answer the findings, the task ended `blocked` on a one-line revision that the reviewer had already approved in round 2.

**Impact.** 1–2 extra full-cost turns per review round; a plausible path to a blocked task that was actually fixed,
which then surfaces to the user as "could not be finished".

**Root cause.** Findings are a formal protocol (ids, statuses) rather than a signal the engine can verify against the
change it already has.

**Fix.** (a) Auto-settle a finding when the revision's diff touches the file/lines named in it — the engine already
computes `changedLines` and knows each finding's `file`/`lines`. (b) Accept a prose answer when the diff resolves the
cited location. (c) On the third attempt, hand the disagreement to the lead as a decision instead of blocking.

**Expected improvement.** Removes 1–2 calls per revision round and the false-blocked failure mode.

**Regression risk.** Auto-settling could hide an unfixed finding if the cited location is wrong; require the finding to
carry `file` + `lines` for auto-settlement and otherwise keep the gate.

---

### F12 — The project's full checks run after every cycle, at 300 s each · **Medium · Verified**

**Issue.** `verificationChecks` picks *any* script named test/typecheck/lint (up to 4) and `runChecks` runs all of them,
every cycle, with a 300-second timeout each.

- `workspace/overview.ts:44-52` — selection rule.
- `conversation.ts:1252-1275` — execution, then a fix task owned by the last author on failure.

**Evidence.** A project with `test` and `typecheck` scripts ran **2 checks** on a one-line HTML change (measured, scenario
C). On a large repo this is the dominant wall-clock cost of a trivial edit, before any review or acceptance.

**Impact.** Minutes per trivial change; on failure a whole extra worker turn (plus review) is triggered.

**Fix.** Run the cheapest check that covers the changed files: typecheck for `.ts`/`.tsx`, lint for touched languages,
tests selected by path (vitest/jest `--related`, pytest `-k`, `go test ./pkg/...`). Cache results by
`(command, hash of changed files)`. Skip entirely for docs/assets-only changes. Keep the full suite for `high` risk
(see F4).

**Expected improvement.** Wall-clock for a one-file change from tens of seconds/minutes to a single targeted command.
No token cost change, but a large perceived-speed improvement.

**Regression risk.** Path-scoped tests miss integration failures; the acceptance check and `high` risk tier still run
the full suite, and the run report already lists which command ran.

---

### F13 — `strict: false` on every tool, and argument parsing hides failures · **Medium · Verified**

**Issue.** Tool schemas are not constrained, and malformed arguments are silently coerced.

- `tools/types.ts:112,115` — `strict: false` for every function, including zod-derived ones.
- `engine/agent.ts:116-119` — `parseArgs` catches JSON errors and returns `{}`, so the model sees a zod error about
  *missing fields* rather than "your JSON was invalid", and the round is spent.

**Impact.** With `strict: false` the decoder is free to emit arguments that violate the schema (missing required keys,
wrong enum member), each costing a full round trip. This is a native-capability regression: the provider can constrain
decoding and Octopus declines.

**Fix.** Emit `strict: true` with schemas normalised for strict mode (all properties required; optionals expressed as
`["T", "null"]`), which zod's JSON-schema output supports with a small adapter. Return the raw JSON parse error from
`parseArgs` when parsing fails. Where a deployment rejects `strict`, fall back per-tool via the existing `dropped`
mechanism.

**Expected improvement.** Eliminates the "Invalid arguments" class of round trips (common with large nested arguments
such as `create_task`, `complete_task.responses`, `submit_review.findings`), typically 1–3 calls per task in real runs.

**Regression risk.** Strict schemas reject nested optional objects that Azure does not support in strict mode; the
per-deployment fallback limits the blast radius, and tests with complex tools (`create_task`) must cover it.

---

### F14 — Dead configuration knobs presented as controls · **Medium · Verified**

**Issue.** Parameters are stored, exposed and written by the UI but never reach the model.

- `shared/src/domain.ts:62,88` — `temperature` in the agent contract.
- `db/project.ts:17-18` — `temperature REAL DEFAULT 0.4`, `max_tokens INTEGER DEFAULT 32000`.
- `llm/azure.ts:75-90` — the request body contains no `temperature` and no agent `max_tokens`.
- `web/src/stores/canvas.ts:213,299` — writes `assertiveness`, `creativity`, `strictness`, `debate_style`,
  `max_autonomous_turns` into `behavior`; nothing on the server reads them.

**Impact.** A user who lowers temperature to stop drift sees no effect; the product implies control over parameters it
cannot honour (and correctly *should not* send for reasoning deployments). This reads as "the harness ignores me", and
it is one of the cheapest credibility fixes in the audit.

**Fix.** Delete the unused behaviour keys and the `temperature` field, or gate them behind a provider capability check
and label them "not used by reasoning models". Keep `max_tokens` if it is meant to drive `max_output_tokens`, and make
that explicit.

**Expected improvement.** Removes silent-failure UX; small reduction in agent rows and migration surface.

**Regression risk.** Stored rows contain the keys — keep the columns, stop advertising them, migrate lazily.

---

### F15 — Stateless replay resends every earlier reasoning item · **Medium · Hypothesis (cost) · Verified (mechanism)**

**Issue.** The client is stateless by choice and replays encrypted reasoning content on every step.

- `llm/azure.ts:77-79` — `store: false`, `include: ["reasoning.encrypted_content"]`.
- `llm/azure.ts:200-205` — the response's whole `output` array (including reasoning items) is returned to the caller.
- `engine/agent.ts:160-166` — `input.push(...res.output)` on every round.

**Impact.** In a 20-step worker turn, the reasoning of steps 1–19 is sent again on step 20. Whether those tokens are
billed at full or cached input rate depends on the deployment's prefix-cache behaviour, and this could not be measured
without credentials — hence "hypothesis" for the magnitude, "verified" for the fact that they are resent.

**Fix.** Prefer server-side state where available (`store: true` + `previous_response_id`), or strip reasoning items
from rounds older than the last 2–3 before sending. Keep `summary: "auto"` for the visible thought stream.

**Expected improvement.** Unknown until measured; measure `usage.input_tokens` per round on a real deployment with and
without reasoning replay — this is the single highest-value measurement still missing from this audit.

**Regression risk.** Dropping reasoning items can reduce coherence on long tool chains; keep the last 2–3 rounds and
measure before adopting globally. This must not be used to "save tokens" if it costs correctness.

---

### F16 — `edit_file` is inconsistent with `write_file` about read state · **Low–Medium · Verified**

**Issue.** `write_file` refuses to overwrite a file the agent has not read and records the new content in `shown`
(`files.ts:116,127-128`); `edit_file` does neither (`files.ts:136-152`) — it never updates `shown`, so the next read of
the edited file returns the whole file again.

**Impact.** Blind edits are allowed (the main defence against stale writes is bypassed), and after every edit the
session's read ledger is wrong, causing an avoidable full re-read.

**Fix.** In `edit_file`, update `shown` with the resulting content hash and the ranges that changed, and require a prior
read (with `seen` hash check) for an edit as well.

**Regression risk.** Requiring a read before edit adds a call where a model edits confidently; keep `write_file`'s
existing escape for files the team created.

---

### F17 — One question to a teammate costs a full turn in a possibly 600k-char session · **Low–Medium · Verified**

**Issue.** `message` to an idle teammate starts an answer turn in its **latest live session** (up to 600k chars,
`conversation.ts:93`), with ≤6 rounds.

- `conversation.ts:544-580` — deliver vs. answer.
- `conversation.ts:581-613` — `answerTurn`, `ANSWER_STEPS = 6`.
- `engine/collab.ts:44-52` — `deliver`/`latestSession` semantics.

**Impact.** "What does this config key mean?" can re-send a 100k+-token session and take 6 rounds. It is also how
agents burn budget coordinating instead of building.

**Fix.** Answer from a *brief-only* consult session by default (small, cheap), and continue the live session only when the
question references specific files it holds. Cap answer turns at 2 rounds; if it needs tools, make it a task.

**Regression risk.** Answers get less informed without the session; the prompt can say "open files only if needed",
which it already does.

---

### F18 — Duplicate and redundant prompt blocks · **Low · Verified**

**Issue.** `ORCHESTRATOR_PROCEDURE` is injected for both `orchestrator` and `report` modes (`prompts.ts:120-121`), so the
final one-paragraph report carries the full hiring/planning procedure (3.9k chars) it cannot execute (`report` mode has no
tools: `tools/index.ts:41`). The roster is the full active team in every prompt (`prompts.ts:110-112`).

**Fix.** A dedicated report card (~300 tokens: what changed, how verified, how to run, what is open; plus the engine's
table). Roster limited to the people this turn can reach.

**Expected improvement.** Report call 12.7k → ~2k chars; roster stops growing linearly with the team.

**Regression risk.** The report tone/format is a product surface; keep the existing formatting rules in the short card.

---

### F19 — Cosmetic correctness of tool replies · **Low · Verified**

- `tools/team.ts` `set_requirements` returns `Recorded \nAssign each to a task…` when every item is a duplicate (all
  filtered out) — measured in the instrumented runs.
- `kinds.ts:31` reports a *lead* specialist as "writes files, so cannot critique", which is the wrong reason and misleads
  the orchestrator into changing the wrong thing.
- `conversation.ts:581-610` `answerTurn` calls `collab.answer()` twice; the second is a harmless no-op only because the
  first deleted the pending entry — fragile, and it can report "(gave no answer)" after a successful `reply` path.

**Fix.** Fix the messages; make `answerTurn` single-settle.

---

## 4. Intelligence degradation report

What actually degrades the model's output, separate from cost:

| Mechanism | Where | Effect on quality |
|---|---|---|
| Wrong owner/specialist classification | F1 | The specialist the user chose never sees the work; review coverage silently drops to a code-only check. |
| Lossy hand-off between planner and worker | F8, F3 | The worker gets a text brief instead of the plan's understanding, so it re-derives decisions and can contradict them. |
| Context compaction rewriting history | F6 | Interfaces, error text and diffs are summarized away exactly on long tasks. |
| Forced phase machine | F4 | The model's natural loop (read → change → verify → report) is split across sessions with different instructions, each with its own idea of the task. |
| Findings protocol | F11 | A correct fix can be blocked by bookkeeping, converting a success into "could not be finished". |
| False completion | F2 | The report asserts work that was never done — the most damaging output in a coding tool. |
| Uniform high effort | F7 | Long reasoning on trivial turns produces over-explanation and delays; the visible plan text gets longer while the work gets smaller. |
| Dead controls | F14 | User intent (temperature/creativity) is silently discarded. |
| Tool schemas not strict | F13 | Malformed arguments cause a retry, and the model learns nothing from it. |
| Bare planning prompt fallback | `plan()` `:938-942` | If the planner ends without a stop tool, its prose is returned as the answer to a work request — "describing instead of doing", structurally. |

Nothing found suggests Octopus is truncating, reordering or corrupting the model's messages, and no instruction
contradicts another (the standards are additive, not conflicting). The degradation is **process**, not prompt conflict.

---

## 5. Where the tokens go

Per call (measured, worker): **~9.9k chars instructions + ~8k chars tool schemas ≈ 5k tokens of fixed prefix**, plus the
transcript. Per request (measured): **6–21 calls**. So:

```
request cost ≈ calls × (fixed prefix + transcript) × effort
                 ↑              ↑            ↑
            F3/F4/F5        F3, F6, F10     F7, F15
```

Ranked contributors to avoidable input:
1. **Number of calls** (F4, F2): 3–7× more than a single delegated loop; the dominant term.
2. **Cold sessions** (F5, F8): every new session re-pays prefix; follow-ups re-pay everything.
3. **Fixed prefix size** (F3, F18): 4–5k tokens per call, of which a report needs ~10%.
4. **Large tool results** (F10): reads up to 10k tokens each, no outline tool, searches not cached.
5. **Replayed reasoning** (F15): grows with turn length; unmeasured.

Avoidable **output**: plan narrated twice (worker + report), review comments restated in the report, orchestrator
procedure read on a report turn, `high` reasoning on trivial turns (F7), and `max_output_tokens: 48_000`
(`agent.ts:159`) which sets no useful ceiling (it is a cap, not a target — but it removes the only pressure against
runaway replies).

---

## 6. Comparative analysis: why the same model does better outside Octopus

| Dimension | Direct harness (one loop, native tools) | Octopus as implemented |
|---|---|---|
| Sessions per request | 1 | 3–7 (plan, worker, N critics, acceptance, report) |
| Model calls for a 1-file change | 3–4 | 6 (measured) |
| Model calls for a small page + review | 5–8 | 16–21 (measured) |
| Follow-up on the same work | same session, 1–2 calls | new sessions, 6 calls incl. a re-read (measured) |
| Instructions per call | 1–2k tokens | 2.5–3.5k tokens + 2.2k schema (measured) |
| Context model | append-only, nothing rewritten | in-place truncation + checkpoint splice (F6) |
| Tool argument validity | constrained decoding (strict) | `strict: false` (F13) |
| Effort | one setting for the loop | `high` for every call (F7) |
| Who decides "done" | the model, with a stop condition | an engine phase machine plus a findings protocol |
| Review | optional, requested by the model or the user | mandatory per part, per round, per specialist |
| Failure of a tool | the loop adapts within the same context | reminder at 3/5/8, then budget exhaustion (F2) |

The model is not being made less capable by a bad prompt. It is being **cut into stages, each with a smaller view of the
task and a bigger prompt**, and the stages are charged to the user. That is exactly why another harness with the same
model looks smarter: it lets the model keep one continuous view of the work.

Second-order effect worth naming: with a mandatory reviewer, an acceptance agent and a requirements table, the planner
spends its effort on *defensible process* (requirements, briefs, specialists) rather than on the requested outcome —
the prompt literally instructs it to. The visible result is a lot of organisational text around a thin piece of work.

---

## 7. Recommended architecture

One principle: **the model stays in control of its reasoning; the engine supplies context, tools, safety and
coordination, and charges only for what the task needs.**

```
Conversation
└─ Lead session (persistent for the conversation)
     ├─ answers, or decides: work      ← 1 session, append-only, cached prefix
     │
     ├─ Work unit (one owner, one session, one loop)
     │    read → change → run/verify → complete
     │    tools: 8–10, strict schemas, 12k-char results, outline+search-cache
     │    effort: high
     │    │
     │    └─ ReviewService (opt-in by risk, not a phase)
     │         trivial → none
     │         small   → diff-only review, 1 call, ~1k tokens, low effort
     │         normal  → 1 reviewer session + targeted checks
     │         high    → specialists (visual/play/security) + acceptance
     │
     └─ Report = the owner's verified summary + engine-generated requirement/status table
          (no separate model call unless the user asks for a narrative)
```

Concrete design rules, each traceable to a finding:

1. **Capability, not rank** decides who writes, reviews and verifies (F1). `is_manager` only chooses reviewers.
2. **Risk selects process** (F4). Tiers are computed from the diff (files, lines, path classes, test presence, whether
   requirements exist) and are visible as a run event; the user can force a tier.
3. **One session per continuous piece of work, kept across requests** (F5). Invalidate per file by hash; compact only at
   a high-water mark; never rewrite what was already sent (F6).
4. **Layered prompts**: core (~600 tokens) + capability card + playbooks by name with an on-demand tool + project map
   only for modes that touch code + roster limited to reachable people (F3, F18).
5. **Effort per mode** (F7), not per model.
6. **Tools that fit in a context window**: 8–10 visible, strict schemas, 12k-char default results with paging, an
   outline/symbol tool, session-scoped search caching (F10, F13).
7. **Failure is information, not a reminder** (F2): signature-based escalation, hard stop after N distinct failures,
   `block_task` with the exact error, and status `incomplete` for any undelivered requirement.
8. **Completion is machine-checkable** (F2, F11): a task is done when its acceptance criteria are checked by tools the
   engine can see (tests, a diff, a screenshot) — not when a model says so, and not blocked by bookkeeping when the
   diff already resolves the finding.
9. **Coordination is a last resort** (F17): shared read-only artifacts (pins, files, task results) instead of chat;
   chat costs a full turn on both sides.
10. **No cap without a reason, no default without a measurement**: every budget in `shared/domain.ts:236`
    (`max_agents 16`, `max_concurrency 3`, `max_revisions 2`) should be justified by the benchmark, not by taste.

What to keep, unchanged: the Responses-API client (streaming, native tool calls, `parallel_tool_calls`, exact usage
accounting, per-deployment parameter fallback), the file versioning/revert model, the safety policy (paths, command
classification, approvals), ownership-by-path for parallel tasks, the event bus and replay, and the session-continuation
idea for revisions and re-reviews.

---

## 8. Implementation roadmap

**Critical — do first, small and surgical**

| # | Change | Files | Effort |
|---|---|---|---|
| 1 | Fix `kindOf` to be capability-derived; add `canReview`/`canVerify`; use them in `staffingError`, `criticsFor`, `verifierFor` (F1) | `catalog/kinds.ts`, `engine/conversation.ts` | 1–2 h |
| 2 | Runtime guard: `criticsFor`/`verifierFor` must **throw with the reason** instead of silently dropping; add a template test (`writers ≥ 1`, `canVerify ≥ 1`) so no shipped template is unusable again (F1) | `engine/conversation.ts`, `catalog/templates.test.ts` | 1 h |
| 3 | Failure-signature escalation + hard stop in `agentLoop`; `open` requirements make a run `incomplete` (F2) | `engine/agent.ts`, `engine/conversation.ts` | 2–3 h |

**High — the cost and quality multipliers**

| # | Change | Effort |
|---|---|---|
| 4 | Risk router: trivial/small/normal/high → review depth, acceptance, checks scope; report merged with the owner's summary (F4, F12) | 1–2 d |
| 5 | Sessions survive cycles; lead session persistent; per-file hash invalidation (F5, F8) | 1 d |
| 6 | Layered prompts: core + capability cards + playbooks-on-demand + scoped roster + project map only where needed (F3, F18) | 1–2 d |
| 7 | Per-mode effort table incl. `summary` off for low modes (F7) | 2 h |
| 8 | Context: append-only projection, engine-built checkpoint, keep `shown` across compaction (F6) | 1 d |

**Medium**

| # | Change | Effort |
|---|---|---|
| 9 | Shared review packet; `quick_review` for any diff-sized change; one visual/play review per part (F9) | 4 h |
| 10 | File tools: 12k default pages, `outline`/`symbols` tool, search cache, `full: true` escape (F10) | 6 h |
| 11 | Findings auto-settle from the diff; escalate disagreements to the lead (F11) | 4 h |
| 12 | Strict tool schemas with per-deployment fallback; honest parse errors (F13) | 4 h |
| 13 | Answer turns: brief-only consult by default, 2 rounds max (F17) | 3 h |

**Low**

| # | Change | Effort |
|---|---|---|
| 14 | Remove or label dead knobs (`temperature`, `assertiveness`, `creativity`, `strictness`, `debate_style`, `max_autonomous_turns`) (F14) | 2 h |
| 15 | `edit_file` read-ledger consistency (F16) | 1 h |
| 16 | Message/answer cosmetics: `set_requirements` duplicates, staffing error text, single-settle in `answerTurn` (F19) | 1 h |
| 17 | Measure and decide on reasoning replay (`store`/`previous_response_id` vs strip) (F15) | needs live deployment |

---

## 9. Validation strategy

**A. Turn the instrumented harness into a benchmark (no credentials needed).** The repo already has everything: a
scripted Responses-API stand-in (`server/test/fakeModel.ts`) that records each request body. Keep the scratch harness
pattern used here as a suite of fixed scripts for five task classes: (1) question, (2) one-file change, (3) small
feature with one review round, (4) bug investigation with a failing check, (5) multi-part feature with two owners.

Assert, per scenario, and fail the build on regressions:

| Metric | Baseline (measured today) | Target |
|---|---|---|
| model calls, one-file change | 6 | ≤ 3 |
| model calls, small feature + review | 16 | ≤ 7 |
| model calls, follow-up on finished work | 6 | ≤ 2 |
| instructions chars per call (worker) | 9.9k | ≤ 3.5k |
| instructions chars per call (quick review) | 8.9k | ≤ 1.5k |
| tool-schema chars per call | 7.5–9k | ≤ 5k |
| `read_file` calls for a file the session already holds | 1+ | **0** |
| runs reported `completed` with an `open` requirement | 1 (observed) | **0** |
| runs whose planner spins ≥ 20 calls after an identical tool error | 1 (observed) | **0** |
| `request_changes` findings resolved by the revision's diff that still block completion | possible | **0** |
| template sanity: every shipped template has ≥1 writer and ≥1 verifier | fails today | passes |

**B. Live A/B, same model and deployment.** Ten representative tasks (single-file edit, multi-file feature, bug from a
failing test, repo-wide analysis, UI page, API + UI pair), each run three times through (i) a plain single-agent loop
with the same tools and model and (ii) Octopus, same prompts for the task. Record per run: input/output/cached tokens,
model calls, tool calls, files read, wall-clock, and a blind human rating (1–5) on: request adherence, correctness,
verification honesty, and least wasted motion. The headline metric is **quality per 100k tokens**, not tokens.

**C. Regression gates.** `npm run typecheck && npm test` plus the new benchmark; then a 30-minute live smoke on a
scratch repo for each risk tier, watching for: phantom specialists in the run events, a report that claims an unmet
requirement, and a follow-up that re-reads a file the session still holds.

**D. What not to do.** Do not lower `maxRounds`, `MAX_TOOL_OUTPUT` or the compaction threshold as a first move — those
bound runaway cost but were not the measured waste; shrinking them first trades correctness for a number. The measured
waste is call count, cold sessions and fixed prefix.

---

## 10. Appendix — raw measurement log

Instrumented runs (scripted model; `instructions`/`input` are characters of the request bodies; per-call schema is the
serialised `tools` array):

```
H question                        1 call   9k instr   4k input   8.9k schema
A one-line page (defaults)        6 calls 41k instr  12k input   7.5k schema   plan 2 / work 2 / review 1 / report 1
B same, review+verify off         5 calls 36k instr  11k input   9.0k schema   plan 2 / work 2 / report 1
C same + project checks           6 calls 41k instr  12k input   7.5k schema   checks run: 2
E 3-line page, review+acceptance 16 calls 98k instr  41k input   8.1k schema   plan 2 / work 10 / review 2 / acc 1 / report 1
F E + designer & QA              21 calls 129k instr 52k input   7.9k schema   plan 3 / work 10 / review 6 / acc 1 / report 1
G follow-up on finished run       6 calls 42k instr  12k input   9.0k schema   plan 2 / work 3 / report 1, includes a re-read
Solo Engineer, real attempt      30 calls 252k instr 347k input  8k schema     completed, R1 open, 0 files
```

Static per-mode instruction sizes (`instructions()` against this repo as the project, overview 3.9k chars):

```
orchestrator 12705   report 12705   worker 9937   acceptance 9654   reviewer 9630   quick_review 8915   consult 8708
```

Template taxonomy (`kindOf` over `buildTemplate`):

```
solo_engineer    writers=0 critics=0 leads=2  → create_task impossible
small_dev_team   writers=2 critics=0 leads=2
software_startup writers=3 critics=1 leads=4  → QA is a lead, cannot verify
web_app_studio   writers=2 critics=0 leads=4  → designer & QA dropped as specialists
full_company     writers=6 critics=4 leads=5  → designer/QA/marketing lead lose their roles
```

