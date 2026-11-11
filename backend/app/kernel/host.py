"""Plugin host: loads plugins in dependency order, runs their lifecycle, and turns them on and off while Octopus runs.

Lifecycle of one plugin: discover (the list given to the host) -> validate (manifest, SDK range, dependency graph) -> resolve
(provides / requires, in start order) -> register (the plugin hands over its services, tools and run methods) -> start
(``plugin.start``) -> healthy or degraded (``plugin.health``) -> stop (reverse dependency order).

``load`` is synchronous and does no I/O, so a fresh process (and a test that never runs the ASGI lifespan) already has every
service in place. ``start`` and ``stop`` are async and belong to the lifespan. The enabled state of each plugin lives in the
registry database (``plugins`` table); ``apply_persisted`` reads it and ``set_enabled`` writes it.
"""
from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from app.foundation.logging import get_logger
from app.kernel.eventlog import EventLog
from app.kernel.registry import PluginRegistry, RegistryError
from app.kernel.services import RunMethodTable, ServiceRegistry, ToolRegistry
from app.sdk.manifest import SDK_VERSION, Manifest
from app.sdk.plugin import Health, Plugin, RunMethod, ToolHandler
from app.storage.repositories import PluginStateRepository
from app.storage.session import SessionFactory

log = get_logger("plugins")

State = Literal["registered", "started", "stopped", "disabled", "blocked", "failed"]
START_TIMEOUT_S = 30.0
STOP_TIMEOUT_S = 10.0
HEALTH_TIMEOUT_S = 5.0


class HostError(RuntimeError):
    """A plugin cannot be loaded, started, enabled or disabled."""


@dataclass
class PluginRecord:
    plugin: Plugin
    state: State = "disabled"
    error: str = ""
    health: Health = field(default_factory=Health)
    cancel: list[Callable[[], None]] = field(default_factory=list)

    @property
    def manifest(self) -> Manifest:
        return self.plugin.manifest


class _Scope:
    """The HostApi one plugin sees. Everything it adds is tagged with the plugin id, so disabling it removes exactly that."""

    def __init__(self, host: PluginHost, record: PluginRecord) -> None:
        self._host, self._record = host, record
        self.services = host.services

    def provide(self, capability: str, service: Any) -> None:
        manifest = self._record.manifest
        if capability not in manifest.provides:
            raise HostError(f"{manifest.id} provides {capability!r} but its manifest does not list it")
        self._host.services.provide(capability, service, owner=manifest.id)

    def add_tools(self, family: str, actions: Mapping[str, ToolHandler]) -> None:
        manifest = self._record.manifest
        self._host.tools.add(manifest.id, family, actions)
        if f"tools.{family}" in manifest.provides:  # lets other plugins require a tool family by name
            self._host.services.provide(f"tools.{family}", sorted(actions), owner=manifest.id)

    def add_run_methods(self, methods: Mapping[str, RunMethod]) -> None:
        self._host.run_methods.add(self._record.manifest.id, methods)

    def subscribe(self, handler: Callable[[dict[str, Any]], Any], *, topics: frozenset[str] | None = None) -> Callable[[], None]:
        cancel = self._host.eventlog.observe(handler, topics)
        self._record.cancel.append(cancel)
        return cancel


class PluginHost:
    def __init__(self, *, services: ServiceRegistry, tools: ToolRegistry, run_methods: RunMethodTable, eventlog: EventLog) -> None:
        self.services, self.tools, self.run_methods, self.eventlog = services, tools, run_methods, eventlog
        self._plugins: list[Plugin] = []
        self._records: dict[str, PluginRecord] = {}
        self._registry: PluginRegistry | None = None
        self._started = False
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ loading
    def add(self, plugins: Iterable[Plugin]) -> None:
        if self._registry is not None:
            raise HostError("plugins must be added before load()")
        self._plugins.extend(plugins)

    def load(self, disabled: Iterable[str] = ()) -> None:
        """Validate the plugin set and register every enabled plugin whose requirements are met. Synchronous, no I/O."""
        manifests = []
        for plugin in self._plugins:
            m = plugin.manifest
            if not m.compatible(SDK_VERSION):
                raise HostError(f"{m.id} needs octopus-sdk {m.sdk}; this is {SDK_VERSION}")
            manifests.append(m)
        try:
            self._registry = PluginRegistry(manifests)
        except RegistryError as exc:
            raise HostError(str(exc)) from exc
        by_id = {p.manifest.id: p for p in self._plugins}
        self._records = {pid: PluginRecord(by_id[pid]) for pid in (m.id for m in manifests)}
        off = {pid for pid in disabled if pid in self._records and not self._records[pid].manifest.required}
        for pid in off:
            self._registry.disable(pid)
        enabled_caps: set[str] = set()
        for manifest in self._registry.all_in_start_order():
            record = self._records[manifest.id]
            if manifest.id in off:
                record.state = "disabled"
                continue
            missing = [need for need in manifest.requires if need not in enabled_caps]
            if missing:
                if manifest.required:
                    raise HostError(f"required plugin {manifest.id} needs {missing}, which no enabled plugin provides")
                record.state, record.error = "blocked", f"needs {', '.join(missing)}"
                continue
            self._register(record)
            if record.state == "registered":
                enabled_caps.update(manifest.provides)

    def _register(self, record: PluginRecord) -> None:
        manifest = record.manifest
        try:
            record.plugin.register(_Scope(self, record))
        except Exception as exc:  # noqa: BLE001
            self._unregister(record)
            record.state, record.error = "failed", f"{type(exc).__name__}: {exc}"[:300]
            log.error("plugin_register_failed", plugin=manifest.id, error=record.error)
            if manifest.required:
                raise HostError(f"required plugin {manifest.id} failed to register: {record.error}") from exc
            return
        record.state, record.error = "registered", ""

    def _unregister(self, record: PluginRecord) -> None:
        pid = record.manifest.id
        self.services.remove_owner(pid)
        self.tools.remove_owner(pid)
        self.run_methods.remove_owner(pid)
        for cancel in record.cancel:
            cancel()
        record.cancel.clear()

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        async with self._lock:
            for manifest in self._ordered():
                record = self._records[manifest.id]
                if record.state == "registered" and manifest.start == "eager":
                    await self._start_one(record)
            self._started = True

    async def _start_one(self, record: PluginRecord) -> None:
        manifest = record.manifest
        try:
            await asyncio.wait_for(record.plugin.start(_Scope(self, record)), START_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            self._unregister(record)
            record.state, record.error = "failed", f"{type(exc).__name__}: {exc}"[:300]
            log.error("plugin_start_failed", plugin=manifest.id, error=record.error)
            if manifest.required:
                raise HostError(f"required plugin {manifest.id} failed to start: {record.error}") from exc
            return
        record.state = "started"

    async def stop(self) -> None:
        async with self._lock:
            for manifest in reversed(self._ordered()):
                record = self._records[manifest.id]
                if record.state in ("started", "registered"):
                    await self._stop_one(record)
            self._started = False

    async def _stop_one(self, record: PluginRecord) -> None:
        try:
            await asyncio.wait_for(record.plugin.stop(), STOP_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 - stopping must continue for the others
            log.warning("plugin_stop_failed", plugin=record.manifest.id, error=str(exc)[:200])
        record.state = "stopped"

    def _ordered(self) -> list[Manifest]:
        assert self._registry is not None, "load() has not run"
        return list(self._registry.all_in_start_order())

    # ------------------------------------------------------------------ toggling
    def dependents_of(self, plugin_id: str) -> list[str]:
        """Enabled plugins that would lose a required capability if ``plugin_id`` were disabled, in stop order."""
        registry = self._need_registry()
        removed = {plugin_id}
        changed = True
        while changed:
            changed = False
            providers: dict[str, set[str]] = {}
            for m in registry.manifests():
                if registry.is_enabled(m.id) and m.id not in removed:
                    for cap in m.provides:
                        providers.setdefault(cap, set()).add(m.id)
            for m in registry.manifests():
                if registry.is_enabled(m.id) and m.id not in removed and any(need not in providers for need in m.requires):
                    removed.add(m.id)
                    changed = True
        order = [m.id for m in reversed(self._ordered())]
        return [pid for pid in order if pid in removed and pid != plugin_id]

    async def set_enabled(self, sf: SessionFactory | None, plugin_id: str, enabled: bool, *, cascade: bool = False) -> list[str]:
        """Turn a plugin on or off and remember it. Returns every plugin whose state changed, in the order they changed."""
        registry = self._need_registry()
        if plugin_id not in self._records:
            raise HostError(f"unknown plugin {plugin_id}")
        record = self._records[plugin_id]
        if record.manifest.required:
            raise HostError(f"{plugin_id} is part of the run loop and cannot be disabled")
        async with self._lock:
            changed: list[str] = []
            if not enabled:
                if not registry.is_enabled(plugin_id) and record.state == "disabled":
                    return []
                dependents = self.dependents_of(plugin_id)
                if dependents and not cascade:
                    raise HostError(f"{plugin_id} is needed by {', '.join(dependents)}; disable them first or cascade")
                for pid in [*dependents, plugin_id]:
                    await self._deactivate(pid)
                    changed.append(pid)
            else:
                if registry.is_enabled(plugin_id) and record.state not in ("disabled", "blocked", "failed"):
                    return []
                for pid in self._providers_to_enable(plugin_id, cascade):
                    await self._activate(pid)
                    changed.append(pid)
            if sf is not None:
                async with sf() as db:
                    repo = PluginStateRepository(db)
                    for pid in changed:
                        await repo.set(pid, enabled=registry.is_enabled(pid), version=self._records[pid].manifest.version)
                    await db.commit()
            return changed

    def _providers_to_enable(self, plugin_id: str, cascade: bool) -> list[str]:
        registry = self._need_registry()
        wanted = [plugin_id]
        enabled_caps = {cap for m in registry.manifests() if registry.is_enabled(m.id) and self._records[m.id].state != "blocked" for cap in m.provides}
        for need in self._records[plugin_id].manifest.requires:
            if need in enabled_caps:
                continue
            providers = [m.id for m in registry.manifests() if need in m.provides and m.id != plugin_id]
            if not providers or not cascade:
                raise HostError(f"{plugin_id} needs {need}, which no enabled plugin provides"
                                + (f" (enable {', '.join(providers)} first)" if providers else ""))
            for pid in providers:
                if pid not in wanted:
                    wanted.insert(0, pid)
        order = {m.id: i for i, m in enumerate(self._ordered())}
        return sorted(wanted, key=order.__getitem__)

    async def _deactivate(self, plugin_id: str) -> None:
        record = self._records[plugin_id]
        if record.state in ("started", "registered"):
            await self._stop_one(record)
        self._unregister(record)
        record.state, record.error = "disabled", ""
        self._need_registry().disable(plugin_id)

    async def _activate(self, plugin_id: str) -> None:
        registry = self._need_registry()
        record = self._records[plugin_id]
        registry.enable(plugin_id)
        self._register(record)
        if record.state == "registered" and self._started and record.manifest.start == "eager":
            await self._start_one(record)

    async def apply_persisted(self, sf: SessionFactory) -> None:
        """Read the plugins table: record versions of new plugins, and switch off the ones the user disabled."""
        async with sf() as db:
            saved = await PluginStateRepository(db).all()
        off = [pid for pid, row in saved.items() if not row.enabled and pid in self._records]
        for pid in off:
            record = self._records[pid]
            if record.manifest.required or record.state == "disabled":
                continue
            deps = self.dependents_of(pid)
            for victim in [*deps, pid]:
                await self._deactivate(victim)
        async with sf() as db:
            repo = PluginStateRepository(db)
            for pid, record in self._records.items():
                row = saved.get(pid)
                if row is None or row.version != record.manifest.version:
                    await repo.set(pid, enabled=self._need_registry().is_enabled(pid), version=record.manifest.version)
            await db.commit()

    # ------------------------------------------------------------------ introspection
    def _need_registry(self) -> PluginRegistry:
        if self._registry is None:
            raise HostError("load() has not run")
        return self._registry

    def record(self, plugin_id: str) -> PluginRecord:
        return self._records[plugin_id]

    def plugins(self) -> list[Plugin]:
        return list(self._plugins)

    def plugin(self, plugin_id: str) -> Plugin:
        return self._records[plugin_id].plugin

    def active(self, slot: str) -> list[Plugin]:
        """The plugins of a slot that are registered and running, providers first."""
        return [self._records[m.id].plugin for m in self._ordered()
                if m.slot == slot and self._records[m.id].state in ("registered", "started")]

    def is_active(self, plugin_id: str) -> bool:
        record = self._records.get(plugin_id)
        return record is not None and record.state in ("registered", "started")

    async def check_health(self) -> dict[str, Health]:
        out: dict[str, Health] = {}
        for pid, record in self._records.items():
            if record.state not in ("started", "registered"):
                continue
            try:
                record.health = await asyncio.wait_for(record.plugin.health(), HEALTH_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                record.health = Health("failed", f"{type(exc).__name__}: {exc}"[:200])
            out[pid] = record.health
        return out

    def describe(self) -> list[dict[str, Any]]:
        registry = self._need_registry()
        rows = []
        for manifest in self._ordered():
            record = self._records[manifest.id]
            rows.append({
                "id": manifest.id, "title": manifest.label, "description": manifest.description, "slot": manifest.slot,
                "kind": manifest.kind, "version": manifest.version, "status": manifest.status, "required": manifest.required,
                "enabled": registry.is_enabled(manifest.id), "state": record.state, "error": record.error,
                "health": {"state": record.health.state, "detail": record.health.detail},
                "provides": list(manifest.provides), "requires": list(manifest.requires), "optional": list(manifest.optional),
                "permissions": list(manifest.permissions), "emits": list(manifest.emits), "ui": list(manifest.ui),
                "start": manifest.start, "sdk": manifest.sdk,
                "dependents": self.dependents_of(manifest.id) if registry.is_enabled(manifest.id) and not manifest.required else [],
            })
        return rows
