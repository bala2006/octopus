"""Compatibility shim. The contracts moved to app.core.contracts in Phase 2 (slice B). Removed in Phase 8."""
from app.core.contracts import (  # noqa: F401
    Assignment,
    ExecutionPolicy,
    choose_lead,
    classify_workflow,
    route_target,
    validate_reporting,
)
