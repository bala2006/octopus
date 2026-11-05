"""Compatibility shim. The contracts moved to app.core.contracts in Phase 2 (slice B), and lead routing moved to
app.agents.chief in Phase 4. Removed in Phase 8."""
from app.agents.chief import choose_lead, route_target, validate_reporting  # noqa: F401
from app.core.contracts import Assignment, ExecutionPolicy, classify_workflow  # noqa: F401
