import pytest
from app.plugins.roles.chief import choose_lead, route_target, validate_reporting
from app.sdk.contracts import classify_workflow


def test_one_lead_and_explicit_eligible_target():
    agents = [{"id": "b", "name": "Sam", "is_entry": True}, {"id": "a", "name": "Ann", "is_entry": True}]
    assert choose_lead(agents) == "a"
    assert choose_lead(agents, "b") == "b"
    assert route_target('@Sam fix this', agents, "a") == "b"
    assert route_target('explain this', agents, "a") == "a"
    with pytest.raises(ValueError, match="unavailable"):
        route_target('hello', agents, "a", "unknown")


def test_reporting_cycles_and_workflow_classification():
    with pytest.raises(ValueError, match="cycle"):
        validate_reporting([{"id": "a", "reports_to": "b"}, {"id": "b", "reports_to": "a"}])
    validate_reporting([{"id": "a"}, {"id": "b", "reports_to": "a"}])
    assert classify_workflow("fix the popup regression") == "fix"
    assert classify_workflow("build a dashboard") == "build"
    assert classify_workflow("review these changes") == "review"
    assert classify_workflow("what does this do?") == "explain"
