"""Registries the plugin host fills: services by capability name, tool actions by name, and methods added to live runs.

Every entry records the plugin that owns it, so disabling a plugin removes exactly what it added. Nothing here imports a
plugin; plugins reach the registries through the host API (app.sdk.plugin.HostApi).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from app.sdk.plugin import RunMethod, ServiceMissing, ToolHandler


class ServiceRegistry:
    """Capability name -> the service an enabled plugin provides under it."""

    def __init__(self) -> None:
        self._services: dict[str, tuple[str, Any]] = {}  # capability -> (owner plugin id, service)

    def provide(self, capability: str, service: Any, *, owner: str) -> None:
        current = self._services.get(capability)
        if current is not None and current[0] != owner:
            raise ValueError(f"{capability!r} is already provided by {current[0]}; {owner} cannot provide it too")
        self._services[capability] = (owner, service)

    def get(self, capability: str) -> Any | None:
        entry = self._services.get(capability)
        return entry[1] if entry else None

    def has(self, capability: str) -> bool:
        return capability in self._services

    def require(self, capability: str) -> Any:
        entry = self._services.get(capability)
        if entry is None:
            raise ServiceMissing(capability)
        return entry[1]

    def owner_of(self, capability: str) -> str | None:
        entry = self._services.get(capability)
        return entry[0] if entry else None

    def remove_owner(self, owner: str) -> list[str]:
        gone = [cap for cap, (who, _) in self._services.items() if who == owner]
        for cap in gone:
            del self._services[cap]
        return gone

    def capabilities(self) -> list[str]:
        return sorted(self._services)


class ToolRegistry:
    """Action name -> handler, grouped in families. The run engine dispatches every agent action through it."""

    def __init__(self) -> None:
        self._families: dict[str, tuple[str, dict[str, ToolHandler]]] = {}  # family -> (owner, actions)
        self._by_action: dict[str, ToolHandler] = {}

    def add(self, owner: str, family: str, actions: Mapping[str, ToolHandler]) -> None:
        if family in self._families and self._families[family][0] != owner:
            raise ValueError(f"tool family {family!r} already belongs to {self._families[family][0]}")
        taken = {a for fam, (who, acts) in self._families.items() if fam != family for a in acts}
        clash = taken & set(actions)
        if clash:
            raise ValueError(f"{owner}: tool actions already registered: {sorted(clash)}")
        self._families[family] = (owner, dict(actions))
        self._rebuild()

    def remove_owner(self, owner: str) -> list[str]:
        gone = [fam for fam, (who, _) in self._families.items() if who == owner]
        for fam in gone:
            del self._families[fam]
        self._rebuild()
        return gone

    def _rebuild(self) -> None:
        self._by_action = {name: fn for _, acts in self._families.values() for name, fn in acts.items()}

    def handler(self, action: str) -> ToolHandler | None:
        return self._by_action.get(action)

    def has(self, action: str) -> bool:
        return action in self._by_action

    def actions(self) -> frozenset[str]:
        return frozenset(self._by_action)

    def family_of(self, action: str) -> str | None:
        return next((fam for fam, (_, acts) in self._families.items() if action in acts), None)

    def families(self) -> dict[str, list[str]]:
        return {fam: sorted(acts) for fam, (_, acts) in sorted(self._families.items())}


class RunMethodTable:
    """Methods plugins add to a live run. A run resolves a name it does not define itself here and binds itself as ``run``."""

    def __init__(self) -> None:
        self._methods: dict[str, tuple[str, RunMethod]] = {}

    def add(self, owner: str, methods: Mapping[str, RunMethod]) -> None:
        for name, fn in methods.items():
            current = self._methods.get(name)
            if current is not None and current[0] != owner:
                raise ValueError(f"run method {name!r} already belongs to {current[0]}")
        for name, fn in methods.items():
            self._methods[name] = (owner, fn)

    def get(self, name: str) -> RunMethod | None:
        entry = self._methods.get(name)
        return entry[1] if entry else None

    def remove_owner(self, owner: str) -> list[str]:
        gone = [name for name, (who, _) in self._methods.items() if who == owner]
        for name in gone:
            del self._methods[name]
        return gone

    def names(self) -> list[str]:
        return sorted(self._methods)


Unsubscribe = Callable[[], None]
