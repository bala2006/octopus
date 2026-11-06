# Octopus architecture refactor: plan

Status: approved direction, Python first. Each phase needs its gates passed and a screenshot sign-off before it merges into the refactor branch.

Branch: `refactor/plugin-architecture`, branched from `feat/global-approval-mode` at `0f31db1`. When the open stack (#73, #74, #75) merges into `main`, the branch is rebased onto `main` and the phase PRs are retargeted.

Target architecture: the five-layer plugin image (Channels, Agents, Workflows, Capabilities, Octopus core), with the Bus running alongside all layers. Dashed boxes in the image are "not built yet".

## 0. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Language: Python 3.11 (the CI pin). A TypeScript port is deferred to after Phase 8 and gets its own plan. | Approved |
| D2 | Plugins are in-process Python packages listed explicitly in a builtin registry. Out-of-process and MCP-based third-party plugins come later. | Approved (default) |
| D3 | Chat apps is a placeholder plugin with status `planned`. It has no routes and no UI. | Approved (default) |
| D4 | The CLI stays the dev scripts. An `octopus` command comes later. | Approved (default) |
| D5 | The visual harness lives in `scripts/visual/`, outside the test suite. The E2E suite stays removed. | Approved (default) |
| D6 | Branch: `refactor/plugin-architecture`, one draft PR per phase, stacked. | Approved |
| O1 | Before #74 merges: confirm the removals of `DirectoryPicker.tsx` and `project_memory.py`. Restore them if they weren't intended. | Open |
| O2 | Merging to `main` publishes images to GHCR under `latest` through CD. Accept this, or gate publishing first. | Open |
| O3 | Screenshot baselines are stored as hashes in git plus PNGs kept as CI artifacts, not committed. | Proposed |
| O4 | Visual threshold: 0 changed pixels by default. Anti-aliasing tolerance is set per screen and recorded in the manifest. | Proposed |

## 1. Rules every phase keeps

- **R1 Behavior unchanged.** No feature is added or removed, except the Chat apps placeholder.
- **R2 UI unchanged.** Same routes, components, CSS, copy, and layout. Screenshot gate on every phase.
- **R3 Contracts unchanged.** The OpenAPI schema, WebSocket event names and payloads, LLM-facing tool names and argument schemas, agent prompts, and the database schema. Database changes are additive migrations only.
- **R4 Dependency direction** is enforced in CI with import-linter: Channels > Agents > Workflows > Capabilities > Core. Core imports nothing from the layers above it.
- **R5 Security boundaries don't move.** The approval gate, sandbox limits, path checks, secret blocking, and project scope keep their tests. New tests prove a plugin cannot skip the policy gate.

## 2. Target layout

```
backend/app/
  core/            # bottom layer: nothing above it is imported here
    bus.py         # the Bus: typed topics over the existing event bus
    registry.py    # plugin registry: discovery, validation, ordering, lifecycle
    manifest.py    # Manifest dataclass
    policy.py      # policy gate: decide(), approvals, budgets
    contracts.py   # task and execution contracts, evidence checks
    run_manager.py # run lifecycle, turn loop, limits, recovery
  capabilities/
    models/        # azure.py, opencode.py, litellm.py, scripted.py
    tools/         # files.py, commands.py, web.py, mcp.py, browser.py, memory.py, skills.py
    sandbox/       # command sandbox and managed processes
    mcp/           # MCP client
    browser/       # Playwright MCP supervisor, live view
    skills/        # skill library
    storage/       # repositories over the registry and project databases
    memory/        # rolling summary and scoped memory
    workspace/     # git worktrees, preview, versions
  workflows/
    boardroom.py   # debate protocol
    review.py      # review gates
    tasks.py       # task board
    company.py     # phases and tracks
    org.py         # org graph, routing, hiring, templates
  agents/
    roles/         # role plugins generated from prompts/roles*.py
    user_roles.py  # roles from the user_roles table
    chief.py       # chief orchestrator: lead selection, entry agents, set_track
  channels/
    api/           # routers (were api/v1)
    ws/            # WebSocket endpoint (was api/ws.py)
    web_shell/     # serves the built UI
    cli/           # dev scripts, native dialog, folder bridge
    chat_apps/     # placeholder, status planned
```

Layer rules, as an import-linter contract:

```ini
[importlinter]
root_package = app

[importlinter:contract:layers]
name = Octopus layers
type = layers
layers =
    app.channels
    app.agents
    app.workflows
    app.capabilities
    app.core
```

Lower layers never import higher ones. Core depends on nothing, so the shims used during transition are the only exceptions, and they're listed in the config until Phase 8 removes them.

## 3. Interfaces

```python
@dataclass(frozen=True)
class Manifest:
    id: str                       # "capability.sandbox"
    layer: Literal["channel", "agent", "workflow", "capability", "core"]
    kind: str
    version: str
    provides: tuple[str, ...]
    requires: tuple[str, ...]
    status: Literal["built", "partly", "planned"]


class Plugin(Protocol):
    manifest: Manifest
    async def start(self, ctx: "PluginContext") -> None: ...
    async def stop(self) -> None: ...


class ToolPlugin(Plugin, Protocol):
    name: str                     # LLM-facing name, frozen by golden files
    input_model: type[BaseModel]  # JSON schema frozen by golden files
    policy: Literal["read", "edit", "command", "external"]
    description: str              # prompt text, frozen by golden files
    async def run(self, ctx: "ToolContext", args: BaseModel) -> "ToolResult": ...


class Provider(Plugin, Protocol):
    async def stream(self, req: "LLMRequest") -> AsyncIterator["LLMChunk"]: ...
```

The Bus keeps the current event names and payloads. Topics are declared once in `core/bus.py`, and golden files lock them.

## 4. Mapping: current code to target

| Target | Current modules |
|---|---|
| Channels / API + WebSocket | `api/v1/*.py`, `api/ws.py`, router list in `main.py` |
| Channels / Web shell | `frontend/`, static serving in `main.py` |
| Channels / CLI & desktop | `scripts/*.py`, `start.sh`, `start.bat`, `octopus.ps1`, `services/native_dialog.py`, `scripts/folder_bridge.py` |
| Channels / Chat apps | none (placeholder) |
| Agents / Chief orchestrator | `engine.py` (lead), `workflow.py` (head), `contracts.choose_lead` |
| Agents / Product & architect | `prompts/roles.py`: pm, architect, techlead |
| Agents / Engineers | `prompts/roles.py`: developer, backend, frontend |
| Agents / Designer & DevOps | `prompts/roles.py`: designer, devops |
| Agents / QA & critic | `prompts/roles.py`: qa, critic |
| Agents / Custom roles | `services/roles.py`, `user_roles` table, `prompts/roles_org.py` |
| Workflows / Boardroom | `orchestrator/protocols.py` (DebateState, moderator, proposer) |
| Workflows / Review gates | `orchestrator/protocols.py` (ReviewState) |
| Workflows / Task board | `actions.UpdateTaskBoard`, `tasks` table, `services/project_tasks.py` |
| Workflows / Company workflow | `orchestrator/workflow.py`, `orchestrator/director.py` |
| Workflows / Org graph & hiring | `orchestrator/team.py`, `permissions.py` (EdgeSpec, routing), `services/canvas.py`, `services/templates.py`, `services/org_generator.py` |
| Capabilities / Models | `llm/router.py`, `llm/azure_v1.py`, `llm/litellm_provider.py`, `llm/pricing.py`, `services/opencode.py`, `orchestrator/opencode.py`, `services/fx.py` |
| Capabilities / File tools | `orchestrator/tools.py`, `tools/workspace.py`, file handlers in `engine.py` |
| Capabilities / Skills | `services/skills.py`, `services/skill_contracts.py`, `app/skills/` |
| Capabilities / MCP servers | `tools/mcp_client.py`, MCP routes in `api/v1/settings.py` |
| Capabilities / Browser | `services/browser.py`, `browser_live.py`, `browser_frames.py` |
| Capabilities / Sandbox | `tools/sandbox.py`, `services/processes.py` |
| Capabilities / Storage | `db/`, `models/`, `migrations/` |
| Capabilities / Memory | `services/scoped_memory.py`, rolling summary in `orchestrator/context.py` |
| Capabilities / Team log | team log in `engine.py`, `orchestrator/runtime_store.py` |
| Capabilities / Git worktrees | `services/git_review.py`, `services/local_environment.py`, `orchestrator/workspaces.py` |
| Capabilities / Preview | `services/preview.py` |
| Capabilities / Versions | artifact model, revert in `api/v1/runs.py`, `publish_file` in `engine.py` |
| Core / Plugin registry | new, plus registry table |
| Core / Plugin contract | new (the `Manifest` and `Plugin` protocols) |
| Core / Event bus | `orchestrator/bus.py` |
| Core / Run manager | `RunRuntime` turn loop and limits, `RunManager` in `engine.py` |
| Core / Policy gate | `orchestrator/permissions.py`, `guard()` and approvals in `engine.py`, approval routes |
| Core / Task contracts | `orchestrator/contracts.py`, `task_contracts.py`, `evidence.py`, `execution.py` |

## 5. Verification system

### Golden artifacts (captured in Phase 0, checked in every phase)

| Artifact | Source | Checks |
|---|---|---|
| `golden/openapi.json` | `export_openapi.py` | No API change |
| `golden/db/registry.sql`, `golden/db/project.sql` | schema dump after all migrations | No schema change |
| `golden/tools.json` | every action: name, input schema, description | Tool names and schemas |
| `golden/prompts/*.txt` | generated system prompt per built-in role | Prompt text, byte for byte |
| `golden/approval_cases.json` | guard decisions for every action kind in `ask` and `auto` | Approval behavior |
| `golden/sandbox_cases.json` | allowed and denied commands, path cases, protected paths | Sandbox behavior |
| `golden/runs/*.jsonl` | scripted runs: event kinds, payload keys, ordering (ids and times stripped) | Event sequence |
| `golden/protocols/*.json` | scripted debate and review transcripts | Protocol behavior |

Determinism: the exporters run twice on the same commit and must produce identical files. Clocks and ids are injected in tests.

### Screenshot baseline

Routes captured at 1440x900 and 1024x768:

- welcome (`/`)
- agent (`/w/:wid/agent`)
- canvas (`/w/:wid/canvas`)
- workspace (`/w/:wid/workspace`)
- chat (`/w/:wid/chat`, `/w/:wid/chat/:sessionId`), plus the floating chat
- runs list (`/w/:wid/runs`), with the run detail in these states: timeline, approval card, question card
- artifacts list and detail (`/w/:wid/artifacts`, `/w/:wid/artifacts/:runId`)
- activity (`/activity`)
- settings (`/settings`)
- guide (`/w/:wid/guide`)
- empty states: no runs, no agents

Seeding uses `tests/fakes` (demo mode was removed in #67). Each screen has a fixed seed so the capture is repeatable.

### Gates (every phase)

| Gate | Check |
|---|---|
| G1 | Backend tests pass (445 today, plus new tests) |
| G2 | Golden artifacts unchanged, or each change listed and approved |
| G3 | import-linter reports no violations |
| G4 | Frontend typecheck, tests (108 today), and build pass |
| G5 | OpenAPI diff is empty, and `api.gen.ts` is in sync |
| G6 | Screenshot diff within the threshold for every screen, or approved |
| G7 | Smoke test: the start script boots, a project opens, a scripted run completes |

## 6. Phases

Sizes: S (days), M (about a week), L (more than a week). These are relative. Gates decide when a phase is done.

### Phase 0: freeze the baseline (S)

Tasks:
1. Create the branch from `0f31db1`, push it, and open a draft PR for this plan.
2. Build `scripts/golden/`: exporters for every golden artifact above, with clock and id injection.
3. Build `scripts/visual/`: Playwright capture with a fixed seed. It uses the Python `playwright` package in a `requirements-dev.txt`, so the stack stays Python.
4. Run each exporter twice and confirm the output is identical.
5. Commit the golden files under `backend/tests/golden/`. Store the screenshot hashes in `visual-baseline/manifest.json`. Keep the PNGs as CI artifacts.
6. Tag the baseline commit `pre-refactor`.

Exit: every gate green on `pre-refactor`. You sign off on the screenshot set.

### Phase 1: plugin core and layer rules (M, no behavior change)

Tasks:
1. Add `core/manifest.py`, `core/registry.py`, and a `PluginContext` with explicit capability handles.
2. Add `core/bus.py`: typed topic constants over `orchestrator/bus.py`. Event names and payloads stay identical.
3. Add the registry table as an additive migration, `registry/0006_plugins`. The table stores enabled state and version. Nothing reads it yet.
4. Write `builtin.py`: a manifest for every current component. The manifests describe the code; they don't replace any wiring yet.
5. Add the import-linter contract, run it in CI, and expose it as `make lint-arch`.
6. Add no new API endpoints, so the OpenAPI schema stays identical.

Exit: G1 to G5 green. The registry lists every component with its layer.

### Phase 2: split the core kernel out of `RunRuntime` (L, highest risk)

Tasks, each slice followed by all gates:

- **Slice A, policy gate:** move `guard()`, `request_approval`, the approval futures, and budget checks into `core/policy.py` as `PolicyGate.decide()`. Approval events stay identical.
- **Slice B, contracts:** move `contracts.py`, `task_contracts.py`, `evidence.py`, and `execution.py` into `core/`. Keep the old module paths as re-export shims, listed in import-linter until Phase 8.
- **Slice C, run manager:** move `RunManager` and the turn loop into `core/run_manager.py`. `RunRuntime` becomes a composition root that holds the services.
- **Slice D, mixins:** replace `ExecutionMixin` with an execution service. `TeamMixin` and `WorkflowMixin` stay until Phase 5.

Exit: `engine.py` is under 800 lines. Golden run sequences and protocol transcripts are unchanged. The security tests pass. Kill switch and restart recovery are covered by tests.

Risks: asyncio cancellation, the mutation and file locks, and the kill switch path.

### Phase 3: capabilities as plugins (L)

Tasks:

1. **Models:** Azure, OpenAI-compatible (LiteLLM, legacy), OpenCode, and the scripted fake move into `capabilities/models/`. The Azure code moves unchanged. The router resolves providers through the registry.
2. **Tools:** each action becomes a `ToolPlugin`, grouped by family: files, commands, web, MCP, browser, memory, skills. Migrate one family per PR. The tool dispatch table in `engine.py` is replaced by a registry lookup.
3. **Sandbox:** `tools/sandbox.py` and `services/processes.py` move into `capabilities/sandbox/`.
4. **MCP, browser, skills, storage, memory, workspace:** each moves into its own package with its tests.
5. Storage exposes repositories. Models stay in one place.

Exit: the engine imports no capability module directly. Tool, provider, and sandbox golden files are unchanged.

### Phase 4: agents as plugins (M)

Tasks:
1. Role plugins generated from `prompts/roles.py` and `prompts/roles_org.py`. Prompt text stays byte-identical. Each plugin carries the image group it belongs to.
2. Custom roles load from the `user_roles` table as role plugins.
3. The chief orchestrator plugin takes lead selection, `set_track`, and entry-agent selection out of `engine.py`.

Exit: prompt goldens identical. Template and team setup tests pass.

### Phase 5: workflows as plugins (M)

Tasks:
1. Boardroom: `protocols.DebateState` moves into `workflows/boardroom.py`.
2. Review gates: `protocols.ReviewState` moves into `workflows/review.py`.
3. Task board: the `UpdateTaskBoard` handler and task persistence move into `workflows/tasks.py`.
4. Company workflow: `workflow.py` moves into `workflows/company.py`, and `WorkflowMixin` is removed.
5. Org and hiring: `team.py`, routing from `permissions.py`, canvas, templates, and the org generator move into `workflows/org.py`. `TeamMixin` is removed.
6. Workflows use the Bus and the policy gate. None imports the engine.

Exit: the engine has no mixins left. Protocol transcripts unchanged. Hiring and approval tests pass.

### Phase 6: channels as plugins (M)

Tasks:
1. The API plugin owns its routers. `main.py` stops listing routers by hand. Paths and prefixes stay identical.
2. The WebSocket plugin owns `/ws`. Event replay behavior is unchanged.
3. The web shell plugin serves the built UI.
4. The CLI plugin holds the dev scripts, the native dialog, and the folder bridge. Start scripts and Makefile targets keep working.
5. The Chat apps placeholder: manifest only, status `planned`.

Exit: OpenAPI identical. WebSocket golden replay identical. G7 smoke test passes on all three start paths.

### Phase 7: frontend mirrors the layers (M)

Tasks:
1. `src/plugins/registry.ts` lists pages and navigation entries, pointing at the existing components.
2. `App.tsx` builds its routes from that registry. The paths and element tree stay the same.
3. Large components (`AgentPanel`, `WorkspacePage`) are split only if needed, and their rendered output must match the baseline screenshots exactly.
4. Regenerate the typed client. Visual components are not otherwise changed.

Exit: G4 to G6 green. Sign-off on the screenshot diff.

### Phase 8: hardening and release (S)

Tasks:
1. Remove every re-export shim. Delete dead code. import-linter runs with no exceptions.
2. Rewrite `ARCHITECTURE.md` to match the image. This also replaces the stale permission and plan-mode text.
3. Write `docs/plugins.md`, a guide for writing a plugin.
4. Compare run timing before and after on the scripted runs, and record the numbers.
5. Open the final PR from the refactor branch into `main`, after your go.

Exit: all gates green. Final approval to merge.

### Deferred: TypeScript port

Planned after Phase 8, with its own plan. The golden files from Phase 0 are the port's specification, so the port can check each module against them.

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Run loop behavior drifts during the split | High | Slices in Phase 2, golden run sequences, scripted-run tests |
| Prompt text changes model behavior | Medium | Byte-identical prompt goldens |
| Tool names or schemas change | Medium | Frozen by `tools.json` |
| A plugin bypasses the policy gate | Medium | Policy tests, plus a test that every tool call goes through `PolicyGate.decide()` |
| Visible UI change | Medium | Screenshot gate every phase, sign-off before each merge |
| Long-lived branch conflicts | High | One stacked PR per phase, merge `main` into the branch often |
| CD publishes on merge to `main` | Certain | O2 must be decided before the final merge |
| No end-to-end test coverage | Certain | Visual harness outside the test suite |

## 8. Open items

- O1: #74 removals (`DirectoryPicker.tsx`, `project_memory.py`).
- O2: GHCR publish on merge to `main`.
- O3: screenshot baseline storage.
- O4: visual threshold per screen.

## 9. Status on this branch

Sections 2 to 6 show the plan's target paths. This section records what the code does now.

### Decisions

- **Phase 0 baseline:** accepted as the reference by the maintainer. Three run screens do not match it and are parked (see G6).
- **Phase 4 custom role group:** confirmed. The four named groups are fixed, and every other built-in role goes to the custom group.
- **O1:** removal of `DirectoryPicker.tsx` and `project_memory.py` (from #74) confirmed. No references remain in this branch.
- **O2:** CD publishing is unchanged. It runs after a successful CI run on `main`, on version tags, and on manual dispatch.
- **O3:** screenshot PNGs stay outside the repo at `/projects/sandbox/visual-baseline`, kept as a CI artifact.
- **Phase 6 dev scripts:** they stay in `scripts/`, and the start scripts stay at the repo root. This is a recorded deviation from the plan.
- **Retargeting PR #76:** it moves to `main` after #75 merges.
- **G7 live check:** the maintainer runs the start paths on their own machine.

### Phases

| Phase | State | Done | Still open |
|---|---|---|---|
| 0 Baseline | Done, parked item | Golden files (62), visual harness, baseline of 36 PNGs. Baseline accepted by the maintainer. | G6: three run screens (see below). |
| 1 Core and rules | Done | Manifests, registry, catalog of 44 entries (33 components, 11 tool families), migration `0006_plugins`, import-linter, `make lint-arch`. | The registry is not read at startup. Manifests have no events, config or lifecycle fields. |
| 2 Kernel | Done | `engine.py` is 652 lines (target under 800). Policy gate, contracts, run manager, execution service, handler modules. Kill-switch and restart-recovery tests exist and pass (47 selected). | None. |
| 3 Capabilities | Partly | Models, workspace, sandbox, browser, MCP, memory, skills and tools are in `app/capabilities/`. The engine imports no capability module (import-linter). Action dispatch is a family-grouped registry (`handlers/registry.py`). Each family is a `ToolPlugin` with its own catalog manifest (11 families). The first storage repository is `TaskRepository` (`app/db/repositories.py`). | Storage repositories for the other tables: about 49 modules still use sessions directly (API 14, orchestrator 11, capabilities 10, workflows 6, services 3, core 3, channels 1, agents 1). Handler modules still import capability modules directly. |
| 4 Agents | Done | Role plugins (`agents/roles`), user roles (`agents/user_roles.py`), chief (`agents/chief.py`). Custom group confirmed. | None. |
| 5 Workflows | Done, with two notes | Debate (`boardroom.py`), review (`review.py`), company workflow (`CompanyWorkflow`), org and hiring (`OrgService`). Mixins are gone. Routing is in `workflows/routing.py`. Task state, the `UpdateTaskBoard` handler and task persistence are in `workflows/task_board.py`. | Notes: the blackboard and nudging stay in `orchestrator/board.py` because they drive run behavior. `workflows/tasks.py` is command discovery, not the board. Workflows import orchestrator types, which import-linter does not check. |
| 6 Channels | Partly | API, WebSocket, web shell and CLI channels. `chat_apps` is a `planned` manifest with no routes. `main.py` mounts the channels. | The start scripts and dev scripts stay where they are (decision). G7 on the three start paths is run by the maintainer. |
| 7 Frontend | Partly | `frontend/src/plugins/registry.ts` builds the routes. Typed client in sync (G5). | G6 is not fully green (see below). |
| 8 Hardening | Partly | Shims removed. import-linter runs three contracts with no ignore list. `ARCHITECTURE.md` and `docs/plugins.md` updated. Timing recorded. | G6 (three screens) and G7 (live start paths). Plan sections 2 to 6 still show target paths. |

### Gates at `b79661b`

- **G1 backend:** 520 passed, 2 skipped. The ruff error gate is clean. One timing test (`test_thinking`) failed once in six full runs, and it passes alone.
- **G2 golden:** all 62 files regenerate with no diff. The approved changes are the `plugins` table (`0006`) and the status-count change in `dff75c1`.
- **G3 import-linter:** 3 contracts kept, 0 ignored.
- **G4 frontend:** typecheck clean, 109 of 109 tests, production build. Last run at `ed16da4`. No frontend source has changed since.
- **G5 OpenAPI:** the golden `openapi.json` is unchanged. `npm run gen:api` reproduces `api.gen.ts` with no diff.
- **G6 screenshots:** 33 of 36 captures match the baseline when captured with the baseline's browser (Chromium 156.0.8078.4, the `chromium_headless_shell-1248` build). The harness takes `--chromium` or `OCTOPUS_VISUAL_CHROMIUM`. Playwright's default browser (157) renders the run screens differently, which explains the earlier failures.
  - Still different, on every capture here: `run-approval` at 1440x900 and 1024x768, and `run-timeline` at 1024x768. The difference is a background tint on one agent row that the run view highlights for four seconds after it changes (`bg-steel/5`, `TeamView.tsx`). Every capture here omits the tint, including captures from the baseline commit `701641a`, so the baseline was taken under a timing this environment does not reproduce.
  - **Parked by the maintainer.** The options (threshold, or replacing the baseline for those three) are still open.
- **G7 start path:** the app boots in-process with the real lifespan (migrations and capability install). The UI returns 200, OpenAPI lists 112 paths, and sampled API routes return 200. No live server was run from the sandbox. The maintainer runs `make start` (and `make dev`) and reports the result.

### Timing

The scripted golden export takes a median of 3.39 s at the Phase 0 commit (`4063c76`) and 3.44 s on this branch. That difference is within noise.

### Known issues

- The `test_thinking` timing test (0.4 s idle timeout) is flaky under load.
- Ruff warnings outside the error gate (unused imports and redefinitions in tests). They predate this branch.
- The approval default test assumed a fresh registry database. It now checks the rule and the persistence instead. Fixed in `b79661b`.
