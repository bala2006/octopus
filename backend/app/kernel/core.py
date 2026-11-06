"""The kernel: the small fixed core that owns the plugin host, the registries, the event log and the run supervisor.

It knows no provider, tool or workflow by name. It runs whatever the enabled plugins provide. ``Kernel`` is built once by the
composition root (app.bootstrap); the parts of Octopus that need it receive it, or ask ``app.kernel.current.current()``.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from app.kernel.current import set_current
from app.kernel.eventlog import EventLog
from app.kernel.host import PluginHost
from app.kernel.policy import PolicyGate
from app.kernel.run_manager import ProjectRef, RunManager
from app.kernel.runtime.engine import RunRuntime, load_run
from app.kernel.services import RunMethodTable, ServiceRegistry, ToolRegistry
from app.sdk.manifest import Manifest
from app.sdk.plugin import Plugin, ServicePlugin


class Kernel:
    def __init__(self, plugins: Iterable[Plugin] = ()) -> None:
        self.services = ServiceRegistry()
        self.tools = ToolRegistry()
        self.run_methods = RunMethodTable()
        self.eventlog = EventLog()
        self.host = PluginHost(services=self.services, tools=self.tools, run_methods=self.run_methods, eventlog=self.eventlog)
        self.runs = RunManager(create=self._new_run, load=load_run)
        self.host.add([*self._components(), *plugins])

    def _new_run(self, run: Any, user_id: str, project: ProjectRef) -> RunRuntime:
        return RunRuntime(run, user_id, project, kernel=self)

    def _components(self) -> list[Plugin]:
        """The kernel's own parts, listed as required plugins so the graph and the Settings page show what depends on them."""

        async def stop_runs() -> None:
            await self.runs.shutdown()

        async def flush_events() -> None:
            await self.eventlog.flush()

        def manifest(pid: str, title: str, description: str, provides: tuple[str, ...], requires: tuple[str, ...] = ()) -> Manifest:
            return Manifest(id=pid, slot="kernel", kind="kernel", version="1.0.0", title=title, description=description,
                            provides=provides, requires=requires, required=True)

        return [
            ServicePlugin(manifest("kernel.eventlog", "Event log", "Persisted, replayable run events with group commit and live fan-out.",
                                   ("bus.events",)), services={"bus.events": lambda: self.eventlog}, on_stop=flush_events),
            ServicePlugin(manifest("kernel.policy", "Policy gate", "The single approval choke point every gated action passes.",
                                   ("policy.gate",)), services={"policy.gate": lambda: PolicyGate}),
            ServicePlugin(manifest("kernel.runs", "Run supervisor", "One actor per run: turn loop, pause, step and stop, recovery.",
                                   ("run.lifecycle",), ("bus.events", "policy.gate")),
                          services={"run.lifecycle": lambda: self.runs}, on_stop=stop_runs),
            ServicePlugin(manifest("kernel.host", "Plugin host", "Loads, orders, starts, stops, enables and disables plugins.",
                                   ("plugins.host",)), services={"plugins.host": lambda: self.host}),
        ]

    # ------------------------------------------------------------------ lifecycle
    def make_current(self) -> None:
        """Make this the process kernel: ``current()`` returns it and plugin packages resolve their dependencies through it."""
        set_current(self)
        for plugin in self.host.plugins():
            bind = getattr(plugin, "bind_deps", None)
            if bind is not None:
                bind(self.services)

    def load(self, disabled: Iterable[str] = ()) -> None:
        self.host.load(disabled)

    async def start(self, registry_sf: Any) -> None:
        await self.host.apply_persisted(registry_sf)
        await self.host.start()

    async def stop(self) -> None:
        await self.runs.shutdown()  # runs first: they use the plugins that are about to stop
        await self.host.stop()
