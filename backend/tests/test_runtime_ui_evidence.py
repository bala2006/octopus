"""UI proof is built from actual broker observations rather than agent claims."""
import pytest

from app.core.config import get_settings
from app.orchestrator import actions as A
from app.orchestrator.evidence import AcceptanceCriterion, RevisionEvidence, validate_evidence
from app.services.browser import SERVER_ID, browser
from test_runtime_recovery_regressions import inspection_runtime, execute  # noqa: F401


@pytest.mark.parametrize("result", ["true", "false"])
async def test_ui_proof_observes_interaction_assertion_and_exact_revision(inspection_runtime, monkeypatch, result):
    runtime = inspection_runtime
    monkeypatch.setattr(get_settings(), "browser_live_frames", False)
    runtime.agents["reviewer"].mcp = [{"id": SERVER_ID, "name": "browser", "builtin": True}]
    async def call(run_id, agent_id, tool, arguments):
        return True, "### Result\n" + (result if tool == "browser_evaluate" else "Clicked restore")
    monkeypatch.setattr(browser, "call", call)
    for tool in ("browser_click", "browser_evaluate"):
        await execute(runtime, "reviewer", A.McpCall(action="mcp_call", server="browser", tool=tool,
            arguments={"function": "() => document.querySelector('main') !== null"} if tool == "browser_evaluate" else {"target": "restore"}))
    ids = list(runtime.observed_checks)
    await execute(runtime, "reviewer", A.RecordInteraction(action="record_interaction", scenario="Restore chat and assert its anchor remains beside composer",
        tool_call_ids=ids, covered_paths=["app.py"], criterion_ids=["popup-anchor"]))
    proof = RevisionEvidence.model_validate(runtime.execution_records[-1])
    assert proof.status == ("pass" if result == "true" else "fail")
    criterion = AcceptanceCriterion(id="popup-anchor", description="Popup anchors after restore", check_kinds=("ui",), required_paths=("app.py",))
    current = runtime.execution.execution_manifest(runtime.root)
    assert validate_evidence(proof, current, task_revision=1, environment=runtime._proof_environment, criterion=criterion).valid == (result == "true")
    (runtime.root / "app.py").write_text("VALUE = 2\n")
    assert not validate_evidence(proof, runtime.execution.execution_manifest(runtime.root), task_revision=1,
                                 environment=runtime._proof_environment, criterion=criterion).valid


async def test_screenshots_and_reordered_claims_cannot_certify_ui(inspection_runtime, monkeypatch):
    runtime = inspection_runtime
    monkeypatch.setattr(get_settings(), "browser_live_frames", False)
    runtime.agents["reviewer"].mcp = [{"id": SERVER_ID, "name": "browser", "builtin": True}]
    async def call(*args):
        return True, "### Result\ntrue"
    monkeypatch.setattr(browser, "call", call)
    for tool in ("browser_take_screenshot", "browser_evaluate"):
        await execute(runtime, "reviewer", A.McpCall(action="mcp_call", server="browser", tool=tool))
    ids = list(runtime.observed_checks)
    action = A.RecordInteraction(action="record_interaction", scenario="A screenshot alone does not prove restoring a popup",
        tool_call_ids=ids, covered_paths=["app.py"], criterion_ids=["popup-anchor"])
    await execute(runtime, "reviewer", action)
    assert runtime.execution_records == []
    await execute(runtime, "reviewer", A.McpCall(action="mcp_call", server="browser", tool="browser_click"))
    click = list(runtime.observed_checks)[-1]
    await execute(runtime, "reviewer", action.model_copy(update={"tool_call_ids": [click, ids[-1]]}))
    assert runtime.execution_records == []
