"""Channels: the top layer. A channel is how a user or an outside client reaches Octopus.

Each channel class has a ``manifest`` that is the matching entry in ``app.core.builtin.BUILTIN_MANIFESTS``. Channels
that serve HTTP or WebSocket traffic also have ``mount(app)``, which registers their routes on a FastAPI app. Channels
import the layers below them. No lower layer imports a channel.
"""
from __future__ import annotations

from app.core.builtin import BUILTIN_MANIFESTS
from app.core.manifest import Manifest


def catalog_manifest(plugin_id: str) -> Manifest:
    """Return the builtin catalog entry for ``plugin_id``, so a channel's manifest and the catalog cannot diverge."""
    for manifest in BUILTIN_MANIFESTS:
        if manifest.id == plugin_id:
            return manifest
    raise KeyError(f"no builtin catalog entry for {plugin_id!r}")
