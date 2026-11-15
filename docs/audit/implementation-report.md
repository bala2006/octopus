# Implementation report: performance and intelligence roadmap

This follows `performance-audit.md` (findings F1–F19). It records what was changed, what was measured, and what remains.
Measurements use the scripted model in `server/test/fakeModel.ts`, so they describe **execution shape** — model calls,
instruction characters, tool work — and not provider token quality.

## 1. What changed

### Stage 1 — correctness

**F1 Agent capabilities** (`catalog/kinds.ts`, `engine/conversation.ts`)
Capability now derives from role kind, never from `is_manager`:

- `kindOf(agent)` — built-in role kind → catalog kind (`manager` kind only when the role genuinely is one).
- `canWrite(agent)` — the role's tools include `write_file`/`edit_file` and its kind is a writer kind.
- `canReview(agent)` — kind is `critic` **and** the agent can read files. A stale `file_write` tool on a QA cannot make it a writer.
- `canVerify(agent)` — the role can read files and run commands.
- `criticsFor` warns through the run's error channel instead of silently dropping a specialist; `verifierFor` and
  `reviewerFor` use the same predicates.

**F2 Failure loops and false completion** (`engine/agent.ts`, `engine/conversation.ts`)

- Failure signatures (tool + normalised error) drive escalation: a second identical failure gets a targeted "you already
  tried this" message with the previous output; a third ends the turn with `stop.kind = "block"`; five consecutive
  failures also end it. The planner turns a blocked turn into `incomplete` instead of looping to its step cap.
- A task turn that ends without `complete_task` is blocked, not done ("Stopped without calling complete_task, so nothing
  was submitted as finished."), and `report()` treats `open` requirements as unresolved.

### Stage 2 — orchestration and process

**F4 Risk-based execution.** Review, acceptance and report remain available, but the engine no longer adds a separate
report turn for a cycle that succeeded plainly (see F18), and effort is scaled by turn kind (F7), so a simple build no
longer pays reasoning prices three times.

**F17 Teammate questions.** An idle agent answers with at most 2 steps, and only loads its own transcript when that
transcript is under 80k characters; otherwise it answers from the question and the shared summary.

**F18 Redundant prompt blocks and reporting.** A cycle with no cycle requirements, no blocked task, no open review
comment, no revision and no failed check is reported by the engine from the owners' own summaries, the changed files and
the checks. The model-written report is still used when there is something to explain (unmet requirements, blocked work,
review disputes), and its prompt is now a ~300-character report card instead of the 3.9k-character orchestration
procedure a tool-less turn cannot execute. The roster, project overview and playbooks are scoped as described under F3.

**F9 Review cost.** A critic that approved a work item keeps its approval: only critics who asked for changes read the
revision (`reviewersFor` / `priorVerdicts`). A revision that nobody objected to still goes to one critic, so nothing
ships unreviewed, and a round where several lenses object still merges all their feedback into one revision. In the
two-specialist benchmark this removed two review turns per repair round.

**F12 Verification scope.** Checks are skipped when every file the cycle changed is a document or an asset, and a check
command that already passed for exactly the same file contents in this conversation is not run again. A cycle that only
edited `README.md` no longer runs the test suite.

**F11 Findings.** Findings belong to the work item, and a revision (a fix after review **or after a failed acceptance**)
answers that item's findings. Previously a revision task's findings list was empty, so answering the finding it was just
told about was rejected with "These ids match no finding", and the task blocked. Fixed in `settle()` via
`state.continues[task.id] ?? task.id`.

**F11b Acceptance repair loop.** When acceptance found a requirement unmet and created a fix, `state.unaccepted` stayed
false, so no re-acceptance was ever queued and the requirement stayed `unmet` forever. `settleAcceptance()` now re-arms
the acceptance after creating fix tasks. This was the difference between the benchmark's two-round scenario ending
`incomplete` and ending `completed`.

### Stage 3 — sessions and context

**F3 Prompt construction** (`engine/prompts.ts`)
`instructions()` builds only what a mode can use: the project overview goes to planning, building and acceptance turns;
the team roster is left out of diff reviews and reports; only the playbooks the task asked for get their full text, role
defaults are listed by name and description. Measured instruction payload dropped by 50–60% (section 3).

**F5 Sessions** (`engine/conversation.ts`)
`finishCycle` no longer clears every session — it keeps them and drops any transcript over `SESSION_MAX_CHARS`, so the
lead's knowledge of the project survives across requests in a conversation. The lead now has a single session for the
conversation. On every user message `refreshFileState()` re-hashes the files each live session holds and drops the
entries that changed on disk, so the rename guard and the "unchanged since you read it" shortcut cannot use stale hashes.

**F6 Compaction.** Existing behaviour is preserved: the transcript is rebuilt from kept items plus a checkpoint instead
of mutating transmitted history, and `shown` survives with the session.

**F16 Editing state** (`tools/files.ts`)
`edit_file` now records the edited line range in the read ledger (hash of the file, range of the edit), so re-reading the
edited lines costs a line; `replace_all` clears the entry because it cannot name the ranges.

### Stage 4 — tokens and tools

**F7 Effort per operation.** `EFFORT` maps orchestrator/worker → high, reviewer/acceptance → medium,
quick_review/report/chat/consult → low, with the conversation budget and the agent's own setting still overriding it.
The UI's "Auto" now says what it does.

**F10 File exploration.** An unqualified read is paged at 12k characters with a "continue with start_line N" header; an
explicit line range still fills up to the 40k tool limit, so targeting a function costs one small read instead of a whole
file.

**F13 Tool arguments.** Malformed JSON is no longer silently parsed as `{}` (which produced confusing "Required" schema
errors). The model is told the arguments were not valid JSON, plus the first 300 characters it sent, and the same for
non-object arguments. Schema failures also echo the received arguments.

Strict schemas are implemented and off by default: `strictParameters()` normalises a schema for strict mode (every
property required, `additionalProperties: false`, optional properties become nullable), `toFunction(tool, strict)`
advertises it, nulls from the model are stripped before validation, and a 400 that complains about the schema drops
strict mode for that model and retries. `AZURE_STRICT_TOOLS=1` turns it on. It stays off until it has been validated
against the deployment, because a wrong strict schema fails every call.

**F14 Configuration.** `max_output_tokens` already reaches the provider; the effort setting's "Auto" description was
corrected to describe the real behaviour. No UI control was found that does not reach the provider.

## 2. Observability

`Usage` (shared) now carries execution counters alongside provider token counts, updated by the engine itself:

| Field | Source |
|---|---|
| `llm_calls`, `input_tokens`, `cached_tokens`, `output_tokens`, `reasoning_tokens`, `cost_usd` | provider usage per call (unchanged) |
| `model_ms` | wall-clock of each model request (`LlmResult.ms`) |
| `agent_runs` | one per agent turn |
| `tool_calls`, `tool_failures` | every tool result, success and failure |
| `file_reads`, `redundant_reads` | `read_file` results; redundant = served from the session ledger |
| `file_writes` | writes, edits, moves and deletes |
| `verifications` | checks actually executed |

They are shown in the run's usage popover ("Execution": agent turns, tool calls, files read, files changed, checks run,
model time) next to the token table, so a run's cost can be explained without reading logs. No file contents, prompts or
credentials are collected.

## 3. Benchmark: before and after

`server/test/benchmark.test.ts` drives the real HTTP API and engine against the scripted model. Each test asserts a call
budget and a payload ceiling, so a regression fails the suite. Numbers are per scenario:

| Scenario | Calls before | Calls after | Instruction chars before | after | Agent turns after | Outcome |
|---|---|---|---|---|---|---|
| Simple question | 1 | 1 | 9k | 5k | 1 | completed |
| Single-file page | 6 | 5 | 41k | 17k | 3 | completed |
| Page + review round + failed acceptance | 16 | 15 | 98k | 41k | 10 | completed (before: requirement never re-accepted) |
| Same + designer and QA | 21 | 18 | 129k | 53k | 12 | completed |
| Follow-up on a changed file | 6 | 5 | — | — | 4 | completed |
| Persistent tool failure | 30, then reported completed | 3 | — | 15k | 1 | **incomplete** (correct) |
| Docs-only change | ran the project's checks | 6 calls, 0 checks | — | 22k | 3 | completed |

Reading the table: the payload fell by 55–58% because prompts are scoped and the report turn lost a procedure it could
not use; one model call disappeared because plain cycles no longer get a separate narrator; and the failure loop collapsed from an exhausted budget to three calls with an honest
`incomplete`. The two-round scenarios still spend a call per review/acceptance pass — that is verification work, not
overhead, and it is the part that must not be cut blindly.

Not measured here: real token and reasoning-token counts, cached-input ratio, and model quality. The scripted model
reports fixed usage. Those need the Azure deployment and a live A/B run (see limitations).

## 4. Tests

- Baseline before work: 125 passing (`server`, vitest).
- Now: 157 passing, typecheck clean in every workspace.
- New: `server/test/kinds.test.ts` (capability predicates and every shipped template's ability to start its work),
  two F2 tests in `conversation.test.ts` (a failing planner stops within four calls; a prose-only worker is blocked), and
  seven benchmark scenarios.
- Rewritten rather than relaxed: the "keeps testing" test created its file first, so its repeated reads succeed; the bug
  it guards (re-reading the same content) is still asserted.

## 5. Lifecycle after the change

```
user message
  └─ lead (persistent session)
       ├─ plain question ─────────────────────────────► reply (1 call)
       ├─ direct message to a teammate ───────────────► answer, ≤2 steps, live session only if <80k
       └─ work
            ├─ hire / tasks / requirements
            ├─ workers (per work item, session reused across revisions)
            │    ├─ read_file (12k page, ledger shortcut) · edit_file (ledger updated)
            │    ├─ failures escalate: 2 → targeted retry, 3 → block, 5 consecutive → block
            │    └─ findings of the work item must be answered before complete_task
            ├─ reviews (diff packet for small code changes; lens review when it needs the product)
            ├─ checks: skipped for docs/assets, cached per file content, then targeted
            ├─ acceptance: unmet → fix task → re-acceptance (now re-armed)
            └─ report: engine-written for plain success; model-written only when there is something to explain
```

## 6. Findings status

| ID | Status | Notes |
|---|---|---|
| F1 | Fixed | Capability from role kind + tools; templates tested |
| F2 | Fixed | Signature escalation, no-stop-turn blocking, open requirements block completion |
| F3 | Fixed | Mode-scoped prompts, playbooks only when requested |
| F4 | Partially fixed | Effort and reporting scale with the task; presets still decide the review pipeline |
| F5 | Partially fixed | Lead persists across requests; per-task worker sessions still start cold by design (a new task's transcript genuinely lacks the file) |
| F6 | Preserved/verified | Rebuild-from-checkpoint kept; `shown` survives |
| F7 | Fixed | Per-mode effort, budget and agent override |
| F8 | Partially fixed | Task briefs carry deps, findings, requirements, docs; planner file-reading duplication untouched |
| F9 | Fixed | Approving critics are not asked again; a change nobody objected to still gets one reviewer |
| F10 | Partially fixed | Paged reads, explicit ranges, ledger dedupe; no symbol outline and no search cache (a cache would return stale results or duplicate text) |
| F11 | Fixed | Work-item findings, re-armed acceptance |
| F12 | Fixed | Docs/assets skip, content-keyed check cache |
| F13 | Fixed (opt-in) | Honest parse errors; strict schemas implemented behind `AZURE_STRICT_TOOLS`, off until validated |
| F14 | Fixed | Effort "Auto" description corrected; output cap reaches the provider |
| F15 | Investigated, unchanged | Encrypted reasoning still replayed; measurement needs a live deployment |
| F16 | Fixed | `edit_file` range ledger, stale-write guard unchanged |
| F17 | Fixed | Answer turns ≤2 steps, live session only under 80k chars |
| F18 | Fixed | Report card replaces the orchestration procedure (3.9k → 0.3k chars); engine-written report for plain cycles; roster/overview/playbooks scoped |
| F19 | Fixed | `set_requirements` reports duplicates instead of "Recorded" with nothing; `answerTurn` settles a question once; the misleading lead-critic message disappeared with `is_manager` |

## 7. Limitations

- **No Azure deployment here.** Token counts, cached-input ratio, reasoning tokens and real quality cannot be measured.
  The benchmark measures calls and characters. A live A/B needs the same deployment, prompts and parameters.
- **Strict tool schemas default to off.** The normaliser and the null stripping are unit-tested, but only a live
deployment can confirm that every tool schema is accepted; turning it on blind could break every call, so it is one
environment variable away rather than on.
- **First-round review is still one turn per lens.** A designer, a QA and a code reviewer each read a new change with
their own brief. Merging them into a single multi-lens review is the remaining F9 opportunity.
- **Sessions persist in memory.** A server restart starts cold; the file ledger is re-derived from reads.
