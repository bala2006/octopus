"""Plugin registry: validates an explicit list of manifests, orders enabled plugins for start, and tracks enabled state.

Pure Python. The registry does no I/O and holds no global state. The caller passes the manifests in. Enabled
state lives only in this object until a later phase reads the plugins table.
"""
from __future__ import annotations

import heapq
from collections.abc import Iterable, Mapping

from app.sdk.manifest import Manifest


class RegistryError(ValueError):
    """The manifest set is inconsistent, or a plugin id is unknown."""


class MissingDependencyError(RegistryError):
    """A plugin requires a capability that no other plugin in scope provides."""


class DependencyCycleError(RegistryError):
    """Plugins require each other in a loop, so no start order exists."""


def _dependency_order(members: Mapping[str, Manifest], scope: str) -> list[str]:
    """Return plugin ids with every provider before the plugins that require it.

    Ties keep registration order. A requirement is satisfied by any other plugin in `members` that provides it.
    Raises MissingDependencyError when a requirement has no provider, and DependencyCycleError when the
    requirements form a loop.
    """
    providers: dict[str, list[str]] = {}
    for plugin_id, manifest in members.items():
        for name in manifest.provides:
            providers.setdefault(name, []).append(plugin_id)

    deps: dict[str, list[str]] = {}
    for plugin_id, manifest in members.items():
        found: list[str] = []
        for name in manifest.requires:
            others = [p for p in providers.get(name, ()) if p != plugin_id]
            if not others:
                raise MissingDependencyError(
                    f"{plugin_id} requires {name!r}, but no other {scope} plugin provides it")
            for other in others:
                if other not in found:
                    found.append(other)
        deps[plugin_id] = found

    position = {plugin_id: i for i, plugin_id in enumerate(members)}
    unmet = {plugin_id: len(found) for plugin_id, found in deps.items()}
    dependents: dict[str, list[str]] = {plugin_id: [] for plugin_id in members}
    for plugin_id, found in deps.items():
        for dep in found:
            dependents[dep].append(plugin_id)

    ready = [(position[p], p) for p, count in unmet.items() if count == 0]
    heapq.heapify(ready)
    order: list[str] = []
    while ready:
        _, plugin_id = heapq.heappop(ready)
        order.append(plugin_id)
        for dependent in dependents[plugin_id]:
            unmet[dependent] -= 1
            if unmet[dependent] == 0:
                heapq.heappush(ready, (position[dependent], dependent))

    if len(order) != len(members):
        unresolved = set(members) - set(order)
        raise DependencyCycleError(_describe_cycle(deps, unresolved, position))
    return order


def _describe_cycle(deps: Mapping[str, list[str]], unresolved: set[str], position: Mapping[str, int]) -> str:
    """Follow requirements inside the unresolved set until an id repeats, then name that loop."""
    current = min(unresolved, key=position.__getitem__)
    path: list[str] = []
    seen: dict[str, int] = {}
    while current not in seen:
        seen[current] = len(path)
        path.append(current)
        # Every unresolved plugin has at least one unresolved dependency, so this always finds one.
        current = next(dep for dep in deps[current] if dep in unresolved)
    loop = path[seen[current]:] + [current]
    return "dependency cycle: " + " requires ".join(loop)


class PluginRegistry:
    def __init__(self, manifests: Iterable[Manifest]) -> None:
        self._manifests: dict[str, Manifest] = {}
        for manifest in manifests:
            if not isinstance(manifest, Manifest):
                raise RegistryError(f"expected a Manifest, got {type(manifest).__name__}")
            if manifest.id in self._manifests:
                raise RegistryError(f"duplicate plugin id: {manifest.id}")
            self._manifests[manifest.id] = manifest
        self._disabled: set[str] = set()
        # Check the whole set, disabled plugins included, so enable() can never reveal a broken graph.
        _dependency_order(self._manifests, scope="registered")

    def manifests(self) -> tuple[Manifest, ...]:
        return tuple(self._manifests.values())

    def get(self, plugin_id: str) -> Manifest:
        self._require(plugin_id)
        return self._manifests[plugin_id]

    def is_enabled(self, plugin_id: str) -> bool:
        self._require(plugin_id)
        return plugin_id not in self._disabled

    def enable(self, plugin_id: str) -> None:
        self._require(plugin_id)
        self._disabled.discard(plugin_id)

    def disable(self, plugin_id: str) -> None:
        self._require(plugin_id)
        self._disabled.add(plugin_id)

    def ordered_for_start(self) -> tuple[Manifest, ...]:
        """Enabled plugins, providers first. Raises if an enabled plugin needs something only a disabled plugin provides."""
        enabled = {pid: m for pid, m in self._manifests.items() if pid not in self._disabled}
        return tuple(self._manifests[pid] for pid in _dependency_order(enabled, scope="enabled"))

    def _require(self, plugin_id: str) -> None:
        if plugin_id not in self._manifests:
            raise RegistryError(f"unknown plugin id: {plugin_id}")
