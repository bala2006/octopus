# Writing a plugin

Octopus plugins run in the same Python process. A plugin is a class that implements its layer's interface, plus a
manifest that declares what it is. The built-in plugins are listed in `backend/app/core/builtin.py`. There is no runtime
loading of third-party code yet. A new plugin is added to the codebase and then to the catalog.

Read `ARCHITECTURE.md` first for the layers and the run flow.

## 1. Pick the layer

| Layer | Package | Put here |
|---|---|---|
| channel | `app/channels/` | a way in or out: HTTP routes, WebSocket, the web shell, CLI scripts |
| agent | `app/agents/` | a role (a prompt and its tools) or the chief's routing rules |
| workflow | `app/workflows/` | a process that spans turns: phases, gates, protocols, org changes |
| capability | `app/capabilities/` | something the runtime uses: a model provider, a tool family, a sandbox, a storage or memory backend |
| core | `app/core/` | contracts, the registry, the bus, the approval gate. Core imports nothing above it. |

A plugin may import its own layer and the layers below. import-linter fails the build otherwise.

## 2. Write the manifest

```python
from app.core.manifest import Manifest

Manifest(
    id="capability.my_search",     # dotted, lowercase, unique
    layer="capability",            # core | capability | agent | workflow | channel
    kind="search",                 # free text: what kind of plugin this is
    version=VERSION,               # at most 40 characters
    provides=("search.web",),      # capability names this plugin offers
    requires=("sandbox.commands",),  # capability names it needs; same layer or lower only
    status="built",                # built | partly | planned
)
```

`status` tells the reader how far the plugin is from its target design. Use `planned` for a placeholder with no
routes or behavior, as the chat apps channel does.

Add the manifest to the catalog in `app/core/builtin.py`. The registry validates each manifest when it is built. It
rejects bad ids, unknown layers and statuses, empty fields, and dependency cycles.

## 3. Give the plugin its behavior

Each layer has its own entry point.

- **Channel**: a class with `manifest` and `mount(app)`. Add it to `app/main.py` in the mount order. The web shell
  mounts last, because its catch-all route must come after every API route.
- **Agent (role)**: a role definition with its prompt and default tools. Built-in roles are generated from
  `app/prompts/roles.py`. Keep prompt text stable. The prompt goldens compare it byte for byte.
- **Workflow**: a class that takes the run runtime (`self.rt`) and uses the public methods on it. Keep the workflow
  out of the engine. Read the run's state through `rt.wf` and the other run attributes, and go through
  `rt.execution` or `PolicyGate` for anything that needs approval.
- **Capability**: implement the functions the runtime needs. The orchestrator never imports a capability module
  directly. It calls a port (see section 4).

## 4. Reach a capability from the orchestrator

The orchestrator calls capabilities through `app/core/ports.py`. The port is a Protocol, and
`app/capabilities/bootstrap.py` holds the built-in implementation. To add a capability the runtime needs:

1. Add the method to `CapabilityHandles` in `app/core/ports.py`. Use core types in the signature.
2. Implement it on `BuiltinCapabilities` in `app/capabilities/bootstrap.py`.
3. Call `ports.handles().<method>(...)` from the orchestrator.

`app.main` runs `install()` in `create_app()`. Any test or script that builds a `RunRuntime` without importing the app
must call `app.capabilities.bootstrap.install()` first. Without it, `ports.handles()` raises an error that names the call
to make.

Core types shared by capabilities and the orchestrator go in `app/core/`. For example, the LLM request and result types
are in `app/core/llm.py`.

## 5. Every action goes through the approval gate

A plugin that changes the project, runs a command, calls an external tool, hires an agent, or edits an agent must ask
`PolicyGate.decide()` first. The gate applies the single approval setting (`ask` or `auto`) and records the decision.
Do not write a second approval path. Add a test for the approval path of each new action.

## 6. Test it

- `cd backend && .venv/bin/lint-imports`: the layer rules must hold.
- `cd backend && .venv/bin/python -m pytest -q`: the suite must pass.
- `cd backend && .venv/bin/python -m scripts.golden.export_all`: regenerate the golden files. A change to a golden file
  means the change is visible to clients or to the model. Review the diff and record why in the commit message.
- Add a focused test for the new behavior. Scripted runs use the fake provider, not the network.

## 7. What plugins cannot do yet

- They cannot be enabled or disabled at runtime. The `plugins` table stores that state, but nothing reads it.
- Tool families are not separate plugins. The action handlers in `app/orchestrator/handlers/` still import capability
  modules directly, and the action dispatch table is still in `engine.py`.
- Third-party code cannot be loaded. A plugin is code in this repository.
