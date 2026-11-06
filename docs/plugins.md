# Writing a plugin

A plugin is a Python object with a manifest and up to four hooks. The kernel's plugin host loads it, orders it after the
plugins it needs, and can switch it off again while Octopus runs. Read `ARCHITECTURE.md` first.

## 1. What a plugin may import

A plugin imports `app.sdk`, `app.storage` and `app.foundation`. It does not import `app.kernel`, `app.application`,
`app.channels`, or another plugin package. import-linter fails the build otherwise (`make lint-arch`).

To use another plugin, ask the host for a capability by name. A package keeps a `Deps` object for this:

```python
# app/plugins/mypkg/deps.py
from app.sdk.plugin import Deps
deps = Deps()

# anywhere in the package, when the capability is needed
sandbox = deps.require("sandbox.exec")      # raises ServiceMissing if that plugin is off
memory = deps.get("memory.scoped")          # None if that plugin is off
```

A tool handler receives the live run as its first argument and reaches services with `rt.services`.

## 2. The manifest

```python
from app.sdk.manifest import Manifest

Manifest(
    id="tool.my_search",            # dotted, lowercase, unique
    slot="tool",                    # channel | provider | tool | workflow | role | knowledge | runner | workspace | observer | service
    kind="tool family",             # free text
    version="1.0.0",
    title="Search tool",            # shown in Settings → Plugins
    description="Search the web with my engine.",
    provides=("tools.my_search",),  # capabilities this plugin offers
    requires=("sandbox.exec",),     # capabilities it needs; it starts after their providers
    optional=("memory.scoped",),    # used when present
    permissions=("network",),       # network | exec | fs_read | fs_write | db | secrets
    emits=("tool_result",),         # run topics it publishes (checked against sdk/topics.py)
    start="eager",                  # "lazy": the host never calls start(); the plugin starts itself on first use
    required=False,                 # True: the run loop cannot work without it, so it has no switch
    sdk=">=1.0,<2",                 # SDK versions it works with
)
```

The manifest is validated when it is built. The host also refuses a plugin whose `sdk` range excludes the running SDK,
a dependency cycle, a requirement nobody provides, and two plugins that provide the same capability.

## 3. The plugin

Describe it with data when it only offers services, tools and run methods:

```python
from app.sdk.plugin import ServicePlugin

def _tools():
    from app.plugins.mypkg import search
    return {"my_search": search.act_my_search}      # action name -> async handler(rt, agent, action)

PLUGINS = (ServicePlugin(MANIFEST, tools={"my_search": _tools}, deps=deps),)
```

`services={"cap.name": factory}` provides services, `run_methods=factory` adds methods to every live run, and `on_start` /
`on_stop` / `check` hook the lifecycle. Factories run when the plugin registers, so a plugin that is off never imports its code.

For anything else subclass `PluginBase` and override `register(host)`, `start(host)`, `stop()` and `health()`.
`register` hands things to the host and must not do I/O:

| Host call | Effect |
|---|---|
| `host.provide(capability, service)` | The capability must be listed in `provides`. |
| `host.add_tools(family, {action: handler})` | Agents can call the action while the plugin is on. If `tools.<family>` is in `provides`, other plugins can require it. |
| `host.add_run_methods({name: fn})` | `fn(run, *args)` becomes `run.name(*args)` for every live run. |
| `host.subscribe(handler, topics=...)` | Observe committed run events. Ends when the plugin is switched off. |

Register the package's plugins in `app/bootstrap.py` (`builtin_plugins`) by adding it to the `packages` tuple. A third-party plugin
object can be passed to `build_kernel(extra=[...])`.

## 4. Every action goes through the policy gate

A handler that changes the project, runs a command, calls an external tool or edits the team calls `await rt.guard(agent, kind,
summary, preview, details, dangerous=...)` first and stops when it returns `(False, reason)`. Do not add a second approval path.
Test the approval path of each new action.

## 5. Switching a plugin off

The host removes the services, tools, run methods and subscriptions the plugin added, then calls `stop()`. Handle absence:
use `deps.get(...)` where the feature can degrade, and declare the capability under `optional`. A run that already holds a
result from the plugin keeps working. The model is no longer offered the plugin's tools, and an action it still sends gets a
notice.

If a plugin keeps its own state outside the host (a registry of providers, a child process), clean it up in `stop()`.

## 6. Test it

- `cd backend && .venv/bin/lint-imports`: the layer and independence contracts must hold.
- `cd backend && .venv/bin/python -m pytest -q`: `tests/test_plugin_host.py` checks that every capability a manifest provides is
  registered and that the code looks up only capabilities its package's manifests declare.
- `cd backend && .venv/bin/python -m scripts.golden.export_all`: regenerate the golden files. A change means a client or the model
  can see it. Review the diff and say why in the commit message.
- Scripted runs use the fake provider, not the network.

## 7. Limits

- Plugins run in the Octopus process. There is no sandbox between a plugin and the rest of the backend.
- There is no discovery from installed packages yet. Add the plugin in `bootstrap.py` or pass it to `build_kernel`.
- Channels (plugins that mount routes) take effect at the next start.
- A plugin has no configuration schema. Read settings the way the existing plugins do.
