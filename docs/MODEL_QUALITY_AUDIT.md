# Model-quality audit

Every place in the model-facing path that limits, truncates, downgrades or replaces what a model sees or produces
(issue #36). Each entry gives the location, the limit, whether it was silent, the effect, and the decision:

- **keep**: justified as is,
- **raise**: limit increased,
- **visible**: still applied, but the model and/or the user now sees it,
- **fix**: behaviour changed.

Paths are relative to `backend/`. Line numbers refer to the commit that closed #36.

## What the model sees (input)

| # | Location | Limit / substitution | Was silent? | Effect on output | Decision |
|---|---|---|---|---|---|
| 1 | `app/llm/router.py:108` | An agent's model not in the configured deployments is replaced by `deployments[0]` | yes | A template or agent naming another model ran on whatever deployment came first, which may be weaker or stronger | **visible**: `prepare_request` returns a warning, shown once per agent in the run and in *Test connection* |
| 2 | `app/llm/router.py:97` | Every provider name is routed to Azure | yes (by design) | None on quality; Azure is the only real provider | **keep** (documented in the router) |
| 3 | `app/llm/router.py:101` | Azure not connected, Demo Mode: provider/model become `mock/demo` | no (warning) | Offline scripted replies | **keep** |
| 4 | `app/orchestrator/engine.py:890`, `:1091` | `budget.force_mock` swaps every call to the mock | no (the user turns Demo Mode on for the run) | Offline scripted replies | **keep** |
| 5 | `app/schemas/__init__.py:345`, `app/orchestrator/context.py:234` | Last `context_recent` (10) of the agent's own messages verbatim; older ones become an extractive summary | partly | Long runs forget earlier asks; this drove the "asked 7 times" behaviour | **raise** + **visible**: summary 3,000 → 6,000 chars (`SUMMARY_CHARS`) with "N earlier messages omitted (decisions, tasks and files are on the Blackboard)". The window stays user-configurable. Repeat asks are also blocked by the intent-aware loop detector (#34). |
| 6 | `app/orchestrator/context.py:24` | Each recent message clipped to 800 chars | marker was "…[truncated]" | Details of recent instructions lost | **raise**: 1,500 chars, marker states "N of M chars" |
| 7 | `app/orchestrator/context.py:23` | Tool results / notices cut at 6,000 chars | **yes, no marker** | An agent reading a large file reasoned about a file whose end it never saw | **fix**: 60,000 chars (`TOOL_RESULT_CHARS`), always marked "showing N of M characters" |
| 8 | `app/orchestrator/engine.py:62` | `read_file` returned the whole file, then the prompt cut it (row 7) | yes | The rest of a file was unreachable | **fix**: `read_file` takes an `offset`; big files come in 59,500-char pages whose header names the next offset |
| 9 | `app/orchestrator/engine.py:741` | Blackboard: goal `[:1500]`, follow-ups `[:600]` (last 5), decisions last 10, user notes last 5 (each `[:300]`) | yes | Long goals and follow-ups lost their tail; older decisions vanished | **raise** + **visible**: goal 6,000, follow-ups 2,000 (stored whole), decisions last 20, notes last 10 (1,000 chars), all cuts marked and older entries counted |
| 10 | `app/orchestrator/engine.py:680`, `app/services/chat.py:104` | Attachments cut at 20,000 / 30,000 chars | yes | Truncated attachments read as complete | **visible**: 30,000 chars with a marker in both places |
| 11 | `app/tools/mcp_client.py:98`, `app/services/browser.py:92` | MCP / browser results cut at 12,000 chars | yes | Partial page snapshots looked complete | **visible**: marker added |
| 12 | `app/tools/sandbox.py:32` | Command output 12,000 chars (head 2,000 + tail) | no (marked) | None | **keep** |
| 13 | `app/orchestrator/engine.py:1319` | `list_files` shows 400 entries | no ("… N more") | None | **keep** |
| 14 | `app/orchestrator/engine.py:1122`, `:1034`, `app/orchestrator/protocols.py:87` | Task descriptions (1,500), decision lines (240), debate outcomes (500) on the Blackboard | yes | None: these are summaries and the full message is still delivered to the recipient and kept in history | **keep** |

## What the model can produce (output)

| # | Location | Limit / substitution | Was silent? | Effect on output | Decision |
|---|---|---|---|---|---|
| 15 | `app/llm/base.py:34`, role templates | Answer budget 2,048 tokens for every agent | yes | No file over ~2k tokens could be written; a cut reply was discarded whole | **fix** (#26): every agent defaults to the model maximum, 128,000 tokens (Azure's documented limit for gpt-6-luna); saved legacy defaults are migrated; a smaller user-set budget that cuts a reply off is raised once and remembered; `write_file` can still append for huge files |
| 16 | `app/llm/azure_v1.py:30` | Fixed 4,096-token reasoning headroom regardless of effort | yes | Raising the effort shrank the space left for the answer | **fix**: headroom follows the effort (none 0 → xhigh 16,384, max 24,576) |
| 17 | `app/orchestrator/engine.py:901` | The repair retry re-sent the bad reply as `text[:4000]` | yes | The model could not see the end of its reply, which is where JSON usually breaks | **fix**: head and tail (6,000 chars) with an omission marker |
| 18 | `app/orchestrator/engine.py:929` | Invalid actions were dropped with a note in the agent's next prompt only | yes (to the user) | The agent may believe it acted; the user never knew | **visible**: a `parse` error event per reply |
| 19 | `app/orchestrator/actions.py:269` | More than 20 actions per reply silently ignored | yes | Lost actions | **visible**: reported as a parse error ("only the first 20 of N actions were run") |
| 20 | `app/orchestrator/actions.py:315` | `thought` clipped to 2,000 chars | yes | None: shown in the UI only, never fed back to a model | **keep** |
| 21 | `app/orchestrator/engine.py:1012` | Loop-detector rejections are not delivered | no (notice + `loop` event) | Intended; the message is a repeat | **keep** (see #34 for the detector itself) |

## Gatekeeping

| # | Location | Limit / substitution | Was silent? | Effect | Decision |
|---|---|---|---|---|---|
| 22 | `app/orchestrator/engine.py:63`, `:1081` | Edge-condition judge: 5 output tokens; an empty or failed reply counted as **YES** | yes | Gated channels leaked whenever the judge didn't answer | **fix**: 16 tokens (+ effort headroom), blackboard 3,000 → 8,000 and message 2,000 → 6,000 chars (marked); YES / NO / *unknown*. Unknown and failures still deliver (a broken judge must not block a run) but emit a warning naming the condition. |

## The areas the issue left open

- **System prompt size.** For the 8-agent Software Startup template the system prompt is about 7,100 chars (~1,800
  tokens) for the CEO and 5,300 (~1,300) for a developer; the agent's own role prompt is ~1,000 chars of that. Small
  next to the 8k-16k answer budgets and the user prompt, and it doesn't crowd out the task. **keep**
- **Response-format overhead.** `schema_doc` is 34-38 % of the system prompt (1,800-2,700 chars). Only the actions an
  agent's tools enable are listed. **keep**
- **Sampling.** `temperature` (default 0.4) is sent only to non-reasoning deployments (`app/llm/azure_v1.py:94`); the
  judge uses 0. No path lowers it elsewhere. **keep**
- **`max_tokens` below the agent's setting.** Judge (row 22), connection test 1,024 (`app/api/v1/settings.py:96`,
  only checks for a reply), org generator 6,000 (`app/services/org_generator.py:203`, one JSON spec). Chat and runs
  use the agent's own value. **keep**
- **Default models.** Role templates and `agent_from_role` use `settings.default_model` (`gpt-6-luna`,
  `app/core/config.py:47`). No role ships with a weaker model. **keep**
- **Retry semantics.** `stream_with_retry` (`app/llm/router.py:118`) retries only when no token was yielded, so no
  partial output is duplicated. Output-limit cut-offs are not retried blindly; the engine retries them once with a
  larger budget (row 15). **keep**
- **Does the recent window include the agent's own past actions?** Its file writes are: each produces an
  `artifact_created` message from the agent, so they show up in its history and on the Blackboard. Reads, tool calls
  and notices are one-off observations and aren't kept. Repeated reads are bounded by the self-activation cap (#27)
  and the stall watchdog (#34). **keep**
- **Frontend.** The run dialog defaults to `context_recent` 10, reasoning effort "default" (each agent's own setting)
  and the agent's model. The inspector default answer budget is now 8,192 (it was 2,048). Nothing else lowers quality
  quietly. **fixed** (answer budget)

## Follow-ups

None. Every item classified as silent and harmful (rows 1, 7-11, 15-19, 22) is fixed in the same change set as this
audit, with regression tests in `backend/tests/test_model_quality.py` and `backend/tests/test_output_limits.py`.
