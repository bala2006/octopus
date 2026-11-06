"""Plugin manifest (v2): the metadata that places a component in a slot and declares what it offers, needs and may do.

A manifest describes a component. It does not start, import, or wire anything. The kernel's plugin host reads it to order
start-up, check compatibility and show the plugin in Settings.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, get_args

# The SDK contract version. A manifest's ``sdk`` range must include it, or the host refuses to load the plugin.
SDK_VERSION = "1.0.0"
SDK_RANGE_DEFAULT = ">=1.0,<2"

Slot = Literal["channel", "provider", "tool", "workflow", "role", "knowledge", "runner", "workspace", "observer", "service", "kernel"]
Status = Literal["built", "partly", "planned"]
Start = Literal["eager", "lazy"]
Permission = Literal["network", "exec", "fs_read", "fs_write", "db", "secrets"]

SLOTS: tuple[str, ...] = get_args(Slot)
STATUSES: tuple[str, ...] = get_args(Status)
STARTS: tuple[str, ...] = get_args(Start)
PERMISSIONS: tuple[str, ...] = get_args(Permission)

# Plugin ids and capability names: dotted lowercase with at least two segments, e.g. "runner.sandbox".
_NAME_RE = re.compile(r"[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+")
_VERSION_RE = re.compile(r"\d+(?:\.\d+){0,2}")
_CLAUSE_RE = re.compile(r"(>=|<=|==|>|<)\s*(\d+(?:\.\d+){0,2})")
VERSION_MAX_LEN = 40  # matches the plugins.version column


class ManifestError(ValueError):
    """A manifest field is missing or invalid."""


def _is_name(value: object) -> bool:
    return isinstance(value, str) and _NAME_RE.fullmatch(value) is not None


def _version_tuple(text: str) -> tuple[int, int, int]:
    parts = [int(p) for p in text.split(".")]
    return (parts + [0, 0, 0])[:3]  # type: ignore[return-value]


def sdk_range_allows(spec: str, version: str = SDK_VERSION) -> bool:
    """True when ``version`` satisfies a comma separated range such as ">=1.0,<2". Raises ManifestError for a bad range."""
    clauses = [c.strip() for c in spec.split(",") if c.strip()]
    if not clauses:
        raise ManifestError(f"sdk range is empty: {spec!r}")
    have = _version_tuple(version)
    for clause in clauses:
        m = _CLAUSE_RE.fullmatch(clause)
        if m is None:
            raise ManifestError(f"sdk range clause {clause!r} must look like '>=1.0'")
        op, want = m.group(1), _version_tuple(m.group(2))
        ok = {">=": have >= want, "<=": have <= want, "==": have == want, ">": have > want, "<": have < want}[op]
        if not ok:
            return False
    return True


@dataclass(frozen=True)
class Manifest:
    id: str                        # "runner.sandbox"
    slot: Slot
    kind: str                      # free text: what kind of plugin this is
    version: str
    provides: tuple[str, ...]      # capability names this plugin offers
    requires: tuple[str, ...]      # capability names this plugin needs from other plugins
    status: Status = "built"       # built | partly | planned
    title: str = ""                # shown in Settings; defaults to the id
    description: str = ""
    sdk: str = SDK_RANGE_DEFAULT   # the SDK versions this plugin works with
    optional: tuple[str, ...] = ()     # capabilities used when present
    permissions: tuple[Permission, ...] = ()
    emits: tuple[str, ...] = ()        # run event topics the plugin publishes
    ui: tuple[str, ...] = ()           # Settings sections the plugin contributes
    start: Start = "eager"             # "lazy": start on first use
    required: bool = False             # the run loop cannot work without it, so it cannot be disabled

    def __post_init__(self) -> None:
        if not _is_name(self.id):
            raise ManifestError(f"plugin id must be dotted lowercase, got {self.id!r}")
        if self.slot not in SLOTS:
            raise ManifestError(f"{self.id}: slot must be one of {SLOTS}, got {self.slot!r}")
        if self.status not in STATUSES:
            raise ManifestError(f"{self.id}: status must be one of {STATUSES}, got {self.status!r}")
        if self.start not in STARTS:
            raise ManifestError(f"{self.id}: start must be one of {STARTS}, got {self.start!r}")
        if not isinstance(self.kind, str) or not self.kind.strip():
            raise ManifestError(f"{self.id}: kind must be a non-empty string")
        if not isinstance(self.version, str) or not self.version.strip() or len(self.version) > VERSION_MAX_LEN:
            raise ManifestError(f"{self.id}: version must be a non-empty string of at most {VERSION_MAX_LEN} characters")
        if not _VERSION_RE.fullmatch(self.version.strip()):
            raise ManifestError(f"{self.id}: version {self.version!r} must look like 1.2.3")
        for field_name in ("provides", "requires", "optional"):
            names = getattr(self, field_name)
            if not isinstance(names, tuple):
                raise ManifestError(f"{self.id}: {field_name} must be a tuple of strings")
            for name in names:
                if not _is_name(name):
                    raise ManifestError(f"{self.id}: {field_name} entry {name!r} must be dotted lowercase")
            if len(set(names)) != len(names):
                raise ManifestError(f"{self.id}: {field_name} lists the same name twice")
        if set(self.optional) & set(self.requires):
            raise ManifestError(f"{self.id}: a capability cannot be both required and optional")
        for field_name in ("permissions", "emits", "ui"):
            if not isinstance(getattr(self, field_name), tuple):
                raise ManifestError(f"{self.id}: {field_name} must be a tuple of strings")
        for perm in self.permissions:
            if perm not in PERMISSIONS:
                raise ManifestError(f"{self.id}: permission {perm!r} must be one of {PERMISSIONS}")
        from app.sdk.topics import RunTopic

        for topic in self.emits:
            if topic not in {t.value for t in RunTopic}:
                raise ManifestError(f"{self.id}: emits {topic!r}, which is not a run topic")
        sdk_range_allows(self.sdk)  # validates the range syntax

    @property
    def label(self) -> str:
        return self.title or self.id

    def compatible(self, sdk_version: str = SDK_VERSION) -> bool:
        return sdk_range_allows(self.sdk, sdk_version)
