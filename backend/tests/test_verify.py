"""Finish honesty: execution without acceptance coverage cannot certify changed code."""
from __future__ import annotations

from pathlib import Path

from app.capabilities.models.router import set_provider_override
from conftest import NativeScriptedProvider, agent, edge, make_company, start_run, wait_status

ON = {"verify_before_finish": True}


def outs(req):  # type: ignore[no-untyped-def]
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


async def test_plain_program_execution_does_not_certify_requested_outcome(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"path": "app.py", "content": "print('hi')\n"})],
        [("finish", {"summary": "done"})],               # sent back: nothing ran app.py
        [("run_code", {"command": "python app.py"})],
        [("finish", {"summary": "ran it: prints hi"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete" and "prints hi" in (done["summary"] or "")
    assert "not verified" in done["halt_reason"]
    evidence = done["state"]["execution_evidence"]
    assert evidence and evidence[-1]["check"]["exit_code"] == 0, "the actual command succeeded"
    assert evidence[-1]["status"] == "unknown", "an unscoped command is not acceptance proof"
    assert evidence[-1]["coverage"] == [] and evidence[-1]["criterion_ids"] == []
    bounce = outs(provider.requests[2])[-1]
    assert "Not finished yet: verify first" in bounce and "app.py" in bounce and "run_code" in bounce
    assert len(provider.requests) == 4, "the bounce kept the turn going instead of ending it"


async def test_bounce_happens_once_and_an_unverified_finish_is_reported_incomplete(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"path": "app.py", "content": "print('hi')\n"})],
        [("finish", {"summary": "done"})], [("finish", {"summary": "can't verify here"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete" and "can't verify" in (done["summary"] or "")
    assert "not verified" in done["halt_reason"]


async def test_integrated_worker_completion_does_not_certify_changed_code(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "write app.py"})], [("finish", {"summary": "ok"})],
                [("finish", {"summary": "Worker output remains unverified"})]],
        "Ben": [[("write_file", {"path": "app.py", "content": "print(1)\n"})], [("finish", {"summary": "written"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("ab", "a", "b")])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete"
    assert "not verified" in done["halt_reason"]
    lead_requests = [r for r in provider.requests if r.metadata["turn_context"]["agent"]["name"] == "Ann"]
    assert any("Not finished yet: verify first" in output for request in lead_requests for output in outs(request))
    assert (Path(workspace["path"]) / "app.py").read_text() == "print(1)\n"
    assert "app.py" in done["state"]["unverified"]


async def test_text_only_changes_finish_directly(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [[("write_file", {"path": "notes.md", "content": "# hi"})], [("finish", {"summary": "done"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and len(provider.requests) == 2
