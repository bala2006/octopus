# Octopus architecture

Octopus runs a team of AI agents against a project folder. This document describes the code as it is on the
`refactor/plugin-architecture` branch. The plan and its status are in `docs/architecture/refactor-plan.md`, and the guide
for adding a plugin is in `docs/plugins.md`.

## 1. Layers

Code is organised in five layers. Each layer may import the layers below it. import-linter enforces the rules (`make lint-arch`).

| Layer | Package (`backend/app/…`) | What it holds |
|---|---|---|
| Channels | `channels/` | How people and tools reach Octopus: the HTTP API, the WebSocket, the built web UI, dev CLI scripts. Chat apps are planned and have no routes yet. |
| Agents | `agents/` | Role plugins (built-in and user roles) and the chief plugin, which picks the lead, routes work and sets the track. |
| Workflows | `workflows/` | Company workflow (phases and gates), org and hiring, debate and review protocols, org templates and generator, and command discovery from project manifests. |
| Orchestrator | `orchestrator/` | The run engine (`RunRuntime`), its turn loop, action handlers, run state and lifecycle. |
| Capabilities | `capabilities/` | Model providers, tools, sandbox, project workspace, browser, MCP, memory, skills. |
| Core | `core/` | Plugin manifests and registry, the built-in catalog, the event bus, the approval gate (`PolicyGate`), run manager, LLM contract, evidence and contracts, capability ports, config and logging. |

The database models live in `models/` and `db/`. Shared request and budget schemas live in `schemas/`.

Core has no upward imports. The engine reaches models, the project filesystem and skills through the ports in
`core/ports.py`. `capabilities/bootstrap.py` fills those ports in once at startup (`app/main.py` calls it in `create_app`).
The engine itself imports no capability module. Its action handlers in `orchestrator/handlers/` still import capability
modules directly (see section 9).

## 2. Storage

| Store | Location | Contents |
|---|---|---|
| Registry | `$OCTOPUS_HOME/registry.db` (default `~/.octopus`) | users, Fernet-encrypted provider keys (plus Azure options), MCP servers (encrypted env and headers), the list of workspaces, the `plugins` table (enabled state and version per plugin) |
| Project | `<project>/.octopus/octopus.db` | companies, agents, edges, chat sessions, runs, messages, run events, tasks, artifact versions, agent memory |
| Project files | `<project>/…` | what agents read and write (sandboxed) |
| Working docs | `<project>/.octopus/work/` | agents' working material (specs, plans, briefs, reviews, QA notes). This is the only part of `.octopus/` agents can read or write. |

Queries go through the repositories in `backend/app/db/repositories.py`. Each repository is bound to a session the caller owns and does not commit, so transactions keep their boundaries. Both databases are migrated with Alembic (`backend/migrations/{registry,project}`). The project database is migrated when
its folder is first opened. Opening a folder that has `.octopus/project.json` re-attaches its history. When a project opens,
any run left `queued` or `running` by the previous process is marked `paused`, so the user can resume it.

## 3. Run flow

One `RunRuntime` (an asyncio task, `orchestrator/engine.py`) runs each run. It is a composition root. It creates
`self.org = OrgService(self)` (team management) and `self.flow = CompanyWorkflow(self)` (the company workflow). Both
services hold the runtime as `self.rt`. `RunRuntime` keeps one-line delegations to their methods, so handlers and tests
call `rt.manages(...)` or `rt.wf_phase()` as before.

Each turn:

1. The turn loop (`orchestrator/turn_loop.py`) builds the prompt: system prompt, roster, channels, blackboard, summary and inbox.
2. The model is called through `ports.handles().stream_llm(req)`.
3. The reply is parsed into actions (`orchestrator/actions.py`, Pydantic models). Each action goes through the approval
   gate, the protocol checks and the limits.
4. The action runs in its handler (`orchestrator/handlers/`): files, commands, web, MCP, browser, memory, skills,
   messaging, tasks, delegation, team, workflow.
5. Messages are routed to mailboxes, and events are persisted and published on the bus. The loop repeats until the run finishes or waits for the user.

Run bookkeeping lives in `run_state.py`, `run_control.py`, `mailbox.py`, `board.py` (blackboard and nudging) and `lifecycle.py`.

## 4. Approvals

There is one approval setting per user, not a per-action permission level. It is either:

- `ask`: the user approves every gated action (commands, edits, external tools, web search, team changes).
- `auto` ("Approve for me"): only dangerous actions ask. Everything else runs without a prompt.

`core/policy.py` (`PolicyGate.decide`) makes every decision. Tool calls, team changes and approval events all go through it.
The approval events and their payloads are the same in both modes. Hiring and editing agents follow the same setting:
in `ask` the change waits for approval before it is saved to the company, and in `auto` it is saved directly.

## 5. Routing and protocols

- **Routing** (`workflows/routing.py`, `find_channel`). A message travels on the edge that matches its direction
  and type. Debate edges carry only debate types. If no edge fits, the message is rejected server-side, and the sender
  gets a notice that explains why (`no channel`, `one-way`, `wrong type`).
- **Debate** (`workflows/boardroom.py`). Decides when a discussion is settled and who speaks next.
- **Review** (`workflows/review.py`). A reviewer answers a request with a verdict and comments.
- **Loop detection** (`workflows/protocols.py`, `LoopDetector`). Shared `Verdict` type, plus detection of agents that
  repeat the same question. Escalation is handled by the run.
- **Task board.** The task state, the `update_task_board` handler and the task rows (through `TaskRepository` in `db/repositories.py`) are in `workflows/task_board.py`. The blackboard and the nudging stay in `orchestrator/board.py`, because they drive run behavior. `workflows/tasks.py` only discovers developer commands from project manifests.

## 6. Company workflow, org and roles

- **Company workflow** (`workflows/company.py`, `CompanyWorkflow`). A run can follow defined phases (intake, spec,
  design, build, test, review, accept) with owners, document handoffs and exit gates. The run option `workflow` is
  `auto`, `on` or `off`. A failed test or review sends the work back to build, up to a fixed number of loops.
- **Org and hiring** (`workflows/org.py`, `OrgService`). Agents can list the team, hire agents and edit their own or
  their reports' settings. Guardrails: hires get only tools the hiring agent has, nobody raises their own turn cap, and
  `budget.max_agents` caps the team size.
- **Templates and generator** (`workflows/templates.py`, `workflows/org_generator.py`). Templates declare departments
  (one manager plus members). `org_generator` builds an org from a goal.
- **Roles** (`agents/roles/`, `agents/user_roles.py`). Built-in roles are plugins generated from `app/prompts/roles.py`
  and `roles_org.py`. Prompt text stays byte-identical. User roles load from the `user_roles` table as role plugins.
- **Chief** (`agents/chief.py`). Lead selection and routing helpers (`choose_lead`, `route_target`, `validate_reporting`).
- **Skills**. Built-in playbooks are `app/skills/*/SKILL.md`. Skill loading lives in `capabilities/skills/`.

## 7. Capabilities

| Capability | Package | Notes |
|---|---|---|
| Models | `capabilities/models/` | Azure Responses API, OpenAI-compatible (LiteLLM) and OpenCode adapters, plus the scripted fake provider used by tests. `router.py` picks the provider and retries streams that fail before any output. The contract types (`LLMRequest`, `LLMResult`, `LLMChunk`, `LLMOutputTruncated`) are in `core/llm.py`. |
| Tools | `capabilities/tools/` | Basic tool implementations and the tool specs the model sees (`specs.py`). |
| Sandbox | `capabilities/sandbox/` | Command allow and deny rules, process supervision. |
| Workspace | `capabilities/workspace/` | `project_fs.py` (sandboxed file access, secrets and ignored directories), git, worktrees, preview serving, stages, and `manifests.py` (artifact manifests with `ProjectFS` as the resolver). |
| Browser | `capabilities/browser/` | One supervised `@playwright/mcp` process on `127.0.0.1`, started on first use and stopped on shutdown. |
| MCP | `capabilities/mcp/` | Client for MCP servers, and the worker bridge. |
| Memory | `capabilities/memory/` | Scoped, versioned project memory in the project database. |
| Skills | `capabilities/skills/` | Skill library, contracts and pinned bundles. |

## 8. Channels and the plugin registry

- **API** (`channels/api/`). Mounts the routers in `app/api/v1/`. Global routers sit under `/api/v1`. Project routers sit
  under `/api/v1/w/{workspace_id}`. Health is at `/api/health`.
- **WebSocket** (`channels/ws/`, `api/ws.py`). Live events for runs and chats, with replay.
- **Web shell** (`channels/web_shell/`). Serves the built UI from `frontend/dist`.
- **CLI** (`scripts/`, `backend/scripts/`). Dev scripts, the runtime doctor, and the golden and visual tooling. The start
  scripts and Makefile targets are unchanged.
- **Chat apps** (`channels/chat_apps/`). A manifest with status `planned`. There are no routes.

Every component has a manifest (`core/manifest.py`): an id such as `capability.sandbox`, a layer, a version, the
capabilities it provides and requires, and a status (`built`, `partly`, or `planned`). `core/registry.py` checks
dependencies, detects cycles and gives the start order. `core/builtin.py` is the catalog of 44 built-in manifests: 33 components and 11 tool families (`tool.*`). The
registry table stores enabled state and version. Nothing reads that table yet.

The frontend mirrors this. `frontend/src/plugins/registry.ts` lists pages and navigation entries, and `routes.tsx`
builds the router from it. The paths and element tree match the earlier `App.tsx`.

## 9. Known gaps

These are the parts of the target design that are not in code yet:

- Tool families are not `ToolPlugin` objects. Actions are grouped by family in `orchestrator/handlers/registry.py`, and the engine dispatches through that registry. The handlers still import capability modules directly.
- Storage repositories are not done. The orchestrator and workflows still use SQLAlchemy sessions directly.
- The task action handler and the blackboard stay in the orchestrator. Only the task state moved to `workflows/task_board.py`.
- `set_track` is handled by `CompanyWorkflow`, not by the chief plugin.
- The registry table is written but not read. Plugins cannot be enabled or disabled at runtime.

## 10. Events and realtime

Runs write `RunEvent` rows and publish them on the bus (`orchestrator/bus.py`, `core/bus.py` for the topic constants).
Event names and payloads are part of the API. Their golden sequences are in `backend/tests/golden/runs/`. The WebSocket
replays events to clients that reconnect. Usage is aggregated per agent and per run, and costs are stored in USD.
`capabilities/models/fx.py` converts them to the display currency.

## 11. Verification

- **Golden files** (`backend/tests/golden/`, regenerated with `python -m scripts.golden.export_all`). They cover OpenAPI,
  the schemas, tool names and schemas, prompts, approval and sandbox cases, scripted runs, and protocol transcripts.
  `test_golden.py` checks them on every test run.
- **Architecture rules** (`backend/.importlinter`). Three contracts: core imports nothing above it, agents stay below the
  orchestrator, the API and channels, and the engine imports no capability module directly.
- **Screenshots** (`scripts/visual/`). Headless Chromium captures for 18 screens at two viewports. Hashes live in
  `scripts/visual/manifest.json`. The PNGs are kept outside the repository.
- **Tests**: `backend` `pytest`, frontend `vitest`, and `tsc --noEmit`.
