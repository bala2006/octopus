"""The plugin contract: what a plugin implements, and the host API it receives.

A plugin is an object with a ``manifest`` and four optional hooks. ``register`` runs once while the host loads the plugin:
it hands the host the services, tool handlers and run methods the plugin offers. It must be cheap and do no I/O.
``start`` and ``stop`` own the plugin's resources (processes, tasks, connections). ``health`` reports its state.

A plugin imports ``app.sdk`` (plus ``app.storage`` and ``app.foundation``) and nothing else. It reaches other plugins only
through ``host.services``, so any plugin can be replaced or disabled without touching the others.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

from app.sdk.manifest import Manifest

# One tool action. Called as handler(run, agent, action); ``run`` is the live RunContext (see app.sdk.run).
ToolHandler = Callable[..., Awaitable[None]]
# A method a plugin adds to the live run. Called as fn(run, *args); the host binds ``run`` as the first argument.
RunMethod = Callable[..., Any]
HealthState = Literal["ok", "degraded", "failed"]


@dataclass(frozen=True)
class Health:
    state: HealthState = "ok"
    detail: str = ""


class ServiceMissing(LookupError):
    """A capability was required and no enabled plugin provides it."""

    def __init__(self, capability: str) -> None:
        super().__init__(f"no enabled plugin provides {capability!r}")
        self.capability = capability


class Services(Protocol):
    """Typed lookup of the capabilities that enabled plugins provide. There are no module-level singletons behind it."""

    def get(self, capability: str) -> Any | None: ...

    def require(self, capability: str) -> Any: ...

    def has(self, capability: str) -> bool: ...


class Deps:
    """A plugin package's late-bound view of the services other plugins provide.

    The package's ``register`` binds it once; library modules in the package then call ``deps.require(...)`` when they need
    another plugin, instead of importing it. If the other plugin is disabled the call raises ServiceMissing.
    """

    def __init__(self) -> None:
        self._services: Services | None = None

    @property
    def bound(self) -> bool:
        return self._services is not None

    def bind(self, services: Services, *, replace: bool = True) -> None:
        """Use ``services`` from now on. With ``replace=False`` an existing binding is kept (first kernel in the process wins)."""
        if replace or self._services is None:
            self._services = services

    def get(self, capability: str) -> Any | None:
        return self._services.get(capability) if self._services is not None else None

    def require(self, capability: str) -> Any:
        if self._services is None:
            raise ServiceMissing(capability)
        return self._services.require(capability)


class HostApi(Protocol):
    """What a plugin may do while it registers or starts."""

    services: Services

    def provide(self, capability: str, service: Any) -> None:
        """Offer ``service`` under ``capability``. The capability must be listed in the manifest's ``provides``."""

    def add_tools(self, family: str, actions: Mapping[str, ToolHandler]) -> None:
        """Offer tool actions. Agents can call them while the plugin is enabled."""

    def add_run_methods(self, methods: Mapping[str, RunMethod]) -> None:
        """Add methods to every live run. Workflow and tool plugins call each other this way instead of importing."""

    def subscribe(self, handler: Callable[[dict[str, Any]], Awaitable[None] | None], *, topics: frozenset[str] | None = None) -> Callable[[], None]:
        """Observe committed run events. Returns a function that cancels the subscription."""


@runtime_checkable
class Plugin(Protocol):
    manifest: Manifest

    def register(self, host: HostApi) -> None: ...

    async def start(self, host: HostApi) -> None: ...

    async def stop(self) -> None: ...

    async def health(self) -> Health: ...


class PluginBase:
    """Convenience base: a plugin overrides only the hooks it needs."""

    manifest: Manifest

    def register(self, host: HostApi) -> None:  # noqa: B027 - deliberately empty
        return None

    async def start(self, host: HostApi) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def health(self) -> Health:
        return Health()


class ServicePlugin(PluginBase):
    """A plugin described by data: the services it provides, the tool families and run methods it adds, and optional hooks.

    ``services`` maps a capability to a zero-argument factory; the factory runs when the plugin registers, so a plugin that
    is switched off never imports or builds its service.
    """

    def __init__(self, manifest: Manifest, *, services: Mapping[str, Callable[[], Any]] | None = None,
                 tools: Mapping[str, Callable[[], Mapping[str, ToolHandler]]] | None = None,
                 run_methods: Callable[[], Mapping[str, RunMethod]] | None = None, deps: Deps | None = None,
                 on_start: Callable[[], Awaitable[None]] | None = None, on_stop: Callable[[], Awaitable[None]] | None = None,
                 check: Callable[[], Awaitable[Health]] | None = None) -> None:
        self.manifest = manifest
        self._services = dict(services or {})
        self._tools = dict(tools or {})
        self._run_methods = run_methods
        self._deps = deps
        self._on_start, self._on_stop, self._check = on_start, on_stop, check

    def register(self, host: HostApi) -> None:
        if self._deps is not None:
            self._deps.bind(host.services, replace=False)
        for capability, factory in self._services.items():
            host.provide(capability, factory())
        for family, factory in self._tools.items():
            host.add_tools(family, factory())
        if self._run_methods is not None:
            host.add_run_methods(self._run_methods())

    def bind_deps(self, services: Services) -> None:
        """Point this plugin package's late-bound dependencies at the kernel that became the process kernel."""
        if self._deps is not None:
            self._deps.bind(services)

    async def start(self, host: HostApi) -> None:
        if self._on_start is not None:
            await self._on_start()

    async def stop(self) -> None:
        if self._on_stop is not None:
            await self._on_stop()

    async def health(self) -> Health:
        return await self._check() if self._check is not None else Health()
