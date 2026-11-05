"""Compatibility shim. The task contracts moved to app.core.task_contracts in Phase 2 (slice B). Removed in Phase 8."""
from app.core.task_contracts import (  # noqa: F401
    TRANSITIONS,
    TaskContract,
    contract,
    dependency_blockers,
    permits_path,
    validate_task,
)
