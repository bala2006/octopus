"""Plugin manifest: the metadata that places a component in a layer and declares what it offers and needs.

A manifest describes a component. It does not start, import, or wire anything.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, get_args

Layer = Literal["channel", "agent", "workflow", "capability", "core"]
Status = Literal["built", "partly", "planned"]

LAYERS: tuple[str, ...] = get_args(Layer)
STATUSES: tuple[str, ...] = get_args(Status)

# Plugin ids and capability names: dotted lowercase with at least two segments, e.g. "capability.sandbox".
_NAME_RE = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+")
VERSION_MAX_LEN = 40  # matches the plugins.version column


class ManifestError(ValueError):
    """A manifest field is missing or invalid."""


def _is_name(value: object) -> bool:
    return isinstance(value, str) and _NAME_RE.fullmatch(value) is not None


@dataclass(frozen=True)
class Manifest:
    id: str                     # "capability.sandbox"
    layer: Layer
    kind: str
    version: str
    provides: tuple[str, ...]   # capability names this plugin offers
    requires: tuple[str, ...]   # capability names this plugin needs from other plugins
    status: Status              # built | partly | planned

    def __post_init__(self) -> None:
        if not _is_name(self.id):
            raise ManifestError(f"plugin id must be dotted lowercase, got {self.id!r}")
        if self.layer not in LAYERS:
            raise ManifestError(f"{self.id}: layer must be one of {LAYERS}, got {self.layer!r}")
        if self.status not in STATUSES:
            raise ManifestError(f"{self.id}: status must be one of {STATUSES}, got {self.status!r}")
        if not isinstance(self.kind, str) or not self.kind.strip():
            raise ManifestError(f"{self.id}: kind must be a non-empty string")
        if not isinstance(self.version, str) or not self.version.strip() or len(self.version) > VERSION_MAX_LEN:
            raise ManifestError(f"{self.id}: version must be a non-empty string of at most {VERSION_MAX_LEN} characters")
        for field_name in ("provides", "requires"):
            names = getattr(self, field_name)
            if not isinstance(names, tuple):
                raise ManifestError(f"{self.id}: {field_name} must be a tuple of strings")
            for name in names:
                if not _is_name(name):
                    raise ManifestError(f"{self.id}: {field_name} entry {name!r} must be dotted lowercase")
            if len(set(names)) != len(names):
                raise ManifestError(f"{self.id}: {field_name} lists the same name twice")
