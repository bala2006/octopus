# Implementation report: performance and intelligence roadmap

This report follows `performance-audit.md` (findings F1 to F19). It describes what the code on this branch does now, after the review corrections to PR #101. Where an older claim was wrong, this report says so.

The measurements use the scripted model in `server/test/fakeModel.ts`. They count model calls, instruction characters and tool work. They do not measure wall-clock time, real token counts, cost or answer quality. No Azure deployment was used, so none of those is claimed here.

## 1. What the code does

### Capability: who may build and review (F1)

`server/src/catalog/kinds.ts` decides what an agent may do from its toolbox and its role.

- `canWrite(agent)` is true only when the role is meant to build and its toolbox allows writing: `file_write` is not `false` and `file_read` is not `false`. A built-in writer such as `frontend` with `file_write` switched off cannot own a part.
- Lead roles (`orchestrator`, `ceo`, `pm`) never own a part.
- A built-in critic such as `designer` stays a critic even if its `file_write` is on.
- `canReview` and `canVerify` are unchanged: a critic that can read, and can run or open the product.

The predicate is used in three places. `staffingError` refuses an owner that cannot write, with the reason. `directTask` creates a `build` task only for an agent that can write. `policyFor` in `server/src/tools/index.ts` gives write and command tools only to an agent that can write.

### Completion: a run is incomplete when work is unresolved (F2, F11)

- A failing tool still escalates. A second identical failure gets a targeted message. A third ends the turn as blocked. Five failures in a row end it too. This is unchanged from the PR.
- A run's status comes from `cycleStatus` in `server/src/engine/conversation.ts`. It is `incomplete` when any task in the cycle is blocked, a project check failed, a requirement is open or unmet, or a blocking finding is unresolved.
- A finding is unresolved until a later review round settles it. An answer of `fixed` or `disputed` alone does not settle it. A fix that changes no file gets no review, so its finding stays unresolved and the run is `incomplete`.
- A part whose review comments are still open at the revision limit is `blocked`. Before this change it was `done`, and the run could still finish `completed`.

### Risk routing: how much checking a change gets (F4)

`server/src/engine/risk.ts` assigns each finished build or fix one of four tiers. The inputs are the files the part changed, the changed lines since its last review, the specialists attached to it, whether requirements are open, and whether it was sent back by review.

| Tier | When | What runs |
|---|---|---|
| trivial | one file, 20 changed lines or fewer, no requirements, no specialists, no configuration or sensitive path, not revised | no review. The owner's `complete_task` summary is the record. Project checks still run. |
| small | more than a trivial edit, up to two files and 80 lines, or any part sent back by review | one quick review from the diff, with no tools. This is the existing quick-review path. |
| normal | requirements still open or unmet, a configuration or dependency file, more than two files, or more than 80 lines | one reviewer with tools. A diff that fits the quick-review limit still gets the quick review. |
| high | specialists attached, a sensitive path, more than eight files, or more than 400 lines | every critic attached to the part, with tools. |

A sensitive path is one with a whole-word match on `auth`, `login`, `session`, `password`, `token`, `secret`, `credential`, `crypto`, `permission`, `payment`, `billing`, `migration`, `schema`, `security`, `env`, `docker`, `github` or `workflows`. A configuration file is a manifest or lock file, a `tsconfig*.json`, a build tool config such as `vite.config.ts`, a `Makefile` or a `.nvmrc`.

Acceptance is unchanged. It runs when requirements are open or unmet. A cycle with requirements is never `trivial`, so the router does not skip a check the user asked for.

Every decision is a `thought` event, for example "T1 is a trivial change (1 file, 2 changed lines), so it is not reviewed."

The router does not let the user or the lead pin a tier. The lead raises the tier only by attaching specialists.

### Context: the file-read ledger survives summarizing (F6)

Compaction still rewrites the transcript in place, as it did before this change. `summarize()` in `server/src/engine/agent.ts` replaces the middle of the transcript with a checkpoint. `truncate()` shortens older tool outputs. The brief and the recent tail are never edited. A test checks the brief and the last output of the transcript.

The file-read ledger (`shown`) is what changed. Each entry now records the transcript position of the tool output that carries its content (`at`).

- Summarizing removes entries whose output was replaced by the checkpoint, and moves the remaining entries to their new positions.
- Shortening removes the entries of the outputs it shortened.
- A read that extends an earlier read of the same content keeps the earlier position. The entry then depends on the older output, which can drop it earlier than needed. That costs one re-read and never returns stale content.

The PR report said the ledger "survives" compaction. That was not true. The code cleared the whole ledger on every summarize and truncate. It is now position-tracked as described above.

`truncate()` also had a size bug. It counted a shortened output as 1,500 characters when it is about 1,300, so it shortened outputs that fit the budget. It now counts the real difference.

### Execution metrics (item 5)

- `model_ms` runs from the first attempt to the last streamed byte. It includes the first network wait, streaming, retries and the waits between retries. Before, it started after the response headers, so a retried call reported almost no time.
- `file_writes` counts write operations: each successful write, edit, move or delete.
- `files_changed` counts distinct project paths the run changed.
- `searches` counts `search_project` calls, including one with an invalid regular expression.
- `listings` counts `list_files` calls.

The run's Execution popover shows "Searches", "Folder listings", "Files changed" (unique paths) and "Files read". The "Files changed" row gives the write-operation count as a hint.

### Check scope: documents and assets (F12, item 6)

Checks are skipped only when every changed file is a document or an asset, and no other project text file names it. `server/src/engine/checkScope.ts` makes that test. A file counts as named when a source file contains its basename, or the folder it sits in followed by `/`.

A manifest such as `requirements.txt` never skips checks. A fixture that a test loads, or an icon that a component imports, runs the checks.

The scan matches names. A file read through a glob that names no folder is not detected, so the checks can be skipped for it. Only text files are scanned, and only for a change that is all documents or assets.

### Unchanged from the PR

F3 (mode-scoped prompts), F7 (effort per mode), F9 (only critics that asked for changes read the revision), F10 (12k-character pages with explicit ranges), F13 (strict tool schemas, off by default), F16 (edit ledger), F17 (answer turns capped at two steps) and F18 (short report card, engine-written report for plain cycles) work as the PR describes.

## 2. Measured results

Both sides ran the same scripted scenarios with the same harness, `server/test/benchmark.test.ts`. "Before" is `origin/main` at `b93a897`. "After" is this branch.

| Scenario | Calls before | Calls after | Instruction chars before | After | Status before | After |
|---|---|---|---|---|---|---|
| Question | 1 | 1 | 8,509 | 5,338 | completed | completed |
| One-file page, no requirements | 6 | 4 | 40,803 | 15,348 | completed | completed |
| Page, review round, failed acceptance | 18 | 15 | 108,957 | 41,330 | incomplete | completed |
| Same, with designer and QA | 23 | 18 | 140,556 | 52,570 | incomplete | completed |
| Follow-up on a changed file | 6 | 5 | not logged | not logged | completed | completed |
| Persistent tool failure | 30 | 3 | 249,900 | 15,477 | completed | incomplete |
| Documents-only change | 9 | 5 | 60,798 | 20,682 | incomplete | completed |

Each side ran five times, alternating. Both sides gave the same call count in every run, because the scripted model is deterministic.

The counts above are not a latency result. The scripted model answers instantly. The benchmark asserts calls and characters only.

Some reads of this table:

- The persistent-failure run on `origin/main` reports `completed` after 30 calls. That was the false completion from F2. This branch stops after 3 calls and reports `incomplete`.
- The one-file page makes no review call. It is a trivial change under the router.
- The review, designer and documents rows end `incomplete` on `origin/main` and `completed` here. This report does not investigate the cause of the `origin/main` status.
- `origin/main` has no usage counters, so its reads, writes, turns and failures are not measured. The branch's values are in the benchmark log. The one-file page writes one file. The follow-up reads `index.html` once with no redundant read, then writes twice. The persistent failure has three tool failures.

The PR report gave 16 and 21 calls before the change for the review and designer rows. This harness measures 18 and 23 on `origin/main`. The table above replaces the PR's numbers.

Instruction characters for three scenarios are pinned exactly in `server/test/benchmark.test.ts`. Any prompt change that adds text fails that test on purpose.

## 3. Validation

Environment: Windows, Node 24.22.3, npm 11.19.1.

| Check | Result |
|---|---|
| `npm run typecheck` (shared, server, web) | passes |
| `npm test`, server (vitest) | 186 tests pass across 16 files |
| `npm test`, web (vitest) | 113 tests pass across 24 files |
| `npm run build` (web: tsc, then vite build) | passes |
| Benchmark, five runs per side | identical counts in every run |

The CI matrix in `.github/workflows/ci.yml` also runs on `ubuntu-latest`. That leg has not run for this branch. The WSL Ubuntu distro does not start on this machine, and validation is limited to Node and TypeScript. Run the CI workflow before merging.

Regression tests added for the corrections:

- `server/test/kinds.test.ts`: customized built-in roles, both writer and reviewer cases, and the command tool a read-only writer gets.
- `server/test/conversation.test.ts`: an open blocking finding at the revision limit makes the run `incomplete`; a one-line change gets no review; a change to an authentication file still gets one; usage counts file operations, unique files and searches; a fixture that a check reads still runs the checks; a built-in writer whose file tools are off is refused a part, and the planner is told why.
- `server/test/agent.test.ts`: the ledger keeps files still in the transcript after summarizing, drops the ones whose output was shortened, and leaves the brief and the tail unchanged.
- `server/test/azure.test.ts`: model time includes the first wait and the retry wait.
- `server/test/checkScope.test.ts` and `server/test/risk.test.ts`: the skip rule and the tier rules, including whole-word sensitive paths.

Existing tests changed on purpose, with their intent kept:

- Review tests that wrote a one-line page now write a 26-line page (`reviewedPage`), because a one-line change is trivial now and the test is about review.
- "A small change is reviewed from its diff in one step" still checks the quick review through the reviewed page.
- "A follow-up is accepted against its own requirements" now expects only the build task, because its change is a one-line rename. It still checks that the earlier request's requirement does not reach the follow-up.
- The benchmark's one-file scenario now asserts two agent turns and no review, where it used to assert one diff review.

## 4. Findings status

| ID | Status | What the code does | Remaining |
|---|---|---|---|
| F1 | Fixed | Capability comes from the toolbox and the role. Covered by kinds, policy and conversation tests. | None known. |
| F2 | Fixed, with one open item | Failure escalation, blocked turns and open requirements all stop false completion. Unresolved blocking findings make a run incomplete. | The planner still has a 30-round budget. The audit's adaptive budget is not built. |
| F3 | Fixed (PR) | Prompts are scoped per mode. | None known. |
| F4 | Partly fixed | The four tiers choose review depth, and each decision is shown as a thought. | No user or lead pin of a tier. A sensitive path does not add a security reviewer by itself; only attached specialists do. The first review round still runs one turn per lens (F9). |
| F5 | Partly fixed | The lead keeps one session for the conversation. Sessions survive a cycle and are dropped above 600,000 characters. File hashes are re-checked on each user message. | Worker sessions start cold for each new task, by design. Every planning turn still resends the role library, the skill list, the limits, the 12-message history digest and the task lists (`orchestratorInput` in `conversation.ts`). |
| F6 | Partly fixed | The ledger survives summarizing and shortening where its content is still in the transcript. The brief and the tail are never edited. | Compaction still rewrites the transcript in place. The audit's append-only projection and structured engine checkpoint are not built. |
| F7 | Fixed (PR) | Effort depends on the turn kind, with the agent and budget settings still overriding it. | None known. |
| F8 | Partly fixed | The lead's session is reused, so planning follows earlier turns. | The per-turn resend described under F5 is still there. A worker still gets a text brief from the lead, not the lead's transcript. |
| F9 | Partly fixed | A critic that approved a part does not read its revision again. | First-round reviews are still one turn per lens, with no shared review packet. |
| F10 | Partly fixed | Reads are paged at 12,000 characters, and an explicit range fills up to the tool limit. | No outline or symbol tool. `search_project` has no cache and walks up to 4,000 files on each call. |
| F11 | Fixed, with one caveat | Findings belong to the part, a revision answers them, and acceptance is re-armed. A blocker still open after the last review makes the run `incomplete`. | A fix answered `fixed` with no file change has no review, so it stays unresolved. That is the intended result, but it can surprise a user. |
| F12 | Fixed, with a limit | Documents and assets skip checks only when no source file names them. Results are cached per file content. | The name match misses a file read through a glob that names no folder. |
| F13 | Fixed, opt-in | Malformed JSON is reported as such. Strict schemas exist behind `AZURE_STRICT_TOOLS`. | Strict mode is off by default because it is not checked against a live deployment. |
| F14 | Not fixed | The PR report said no dead control remained. That is wrong. `temperature`, `assertiveness`, `creativity`, `strictness`, `debate_style` and `max_autonomous_turns` are still stored and written by `web/src/stores/canvas.ts`. No server code reads the behavior keys. `temperature` is not sent to the model. | Remove the keys or label them as unused. This branch does not change them. |
| F15 | Not fixed | Encrypted reasoning items are still replayed on every round. | Needs a live deployment: measure input tokens per round with and without replay. |
| F16 | Fixed (PR) | `edit_file` records the edited range in the ledger. | None known. |
| F17 | Fixed (PR) | An idle teammate answers in at most two steps, and reuses its session only under 80,000 characters. | None known. |
| F18 | Fixed (PR) | The report card replaces the orchestration procedure, and plain cycles get an engine-written report. | None known. |
| F19 | Partly fixed | A reply made with the reply tool settles the question once. `answerTurn` then calls `collab.answer` again, which does nothing. | The second call is not removed. |

## 5. Limits and open items

- No Azure measurement. Token counts, cached input, reasoning tokens, cost and answer quality are unmeasured. The benchmark counts calls and characters, and it has no latency.
- `model_ms` is measured in code and covered by a unit test against a local server that returns a retry. Its value on a real deployment is unmeasured.
- Routing trades review for cost. A one-line change now gets no review. Project checks still run, when the project has them. A one-line change on a sensitive path still gets a review. Whether other one-line changes should be reviewed is a product decision. A team that wants more review can change the rules in `tierOf`.
- Sessions live in memory. A restart starts each conversation from its brief.
- The Linux CI leg has not run for this branch.
