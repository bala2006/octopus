"""Attempt identity shared by every execution path: the superseded signal and the per-attempt context.

Moved from app/orchestrator/execution.py in Phase 2 slice B. execution.py re-exports these names until Phase 8.
"""
from __future__ import annotations

import contextvars
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.core.contracts import Assignment


class SupersededAttempt(Exception):
    pass


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
