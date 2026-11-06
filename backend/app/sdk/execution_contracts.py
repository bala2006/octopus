"""Attempt identity shared by every execution path: the superseded signal and the per-attempt context.

Moved from app/orchestrator/execution.py in Phase 2. Importers use this module directly.
"""
from __future__ import annotations

import asyncio
import contextvars
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from weakref import WeakValueDictionary

from app.sdk.contracts import Assignment


class SupersededAttempt(Exception):
    pass


class Conflict(ValueError):
    """A request lost a race with a committed steer or another writer."""


_mutation_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()


def mutation_lock(run_id: str) -> asyncio.Lock:
    """Serialize steering with canonical writes in this backend process. Database CAS still guards durable state.

    Weak entries do not retain completed runs or locks bound to a closed test event loop.
    Call from the application's event loop, before entering filesystem worker threads.
    """
    lock = _mutation_locks.get(run_id)
    if lock is None:
        lock = asyncio.Lock()
        _mutation_locks[run_id] = lock
    return lock


@dataclass
class AttemptContext:
    id: str
    assignment: Assignment
    tool_manifests: dict[str, Any] = field(default_factory=dict)
    tool_details: dict[str, dict] = field(default_factory=dict)
    workspace: Path | None = None
    pending_artifacts: dict[str, dict] = field(default_factory=dict)
    pending_finish: Any = None
    integrated: bool = False
    error: str | None = None


ACTIVE_ATTEMPT: contextvars.ContextVar[AttemptContext | None] = contextvars.ContextVar("octopus_attempt", default=None)
