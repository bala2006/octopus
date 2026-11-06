"""Scoped memory knowledge plugin: versioned notes for agents, groups, chats and projects."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin


def _scoped():
    from app.plugins.memory import scoped
    return scoped


PLUGINS = (
    ServicePlugin(
        Manifest(id="knowledge.memory", slot="knowledge", kind="memory", version="1.0.0", title="Scoped memory",
                 description="Versioned notes with sources, shared only to the audience the owner chooses.",
                 provides=("memory.scoped",), requires=(), permissions=("db",)),
        services={"memory.scoped": _scoped}),
)
