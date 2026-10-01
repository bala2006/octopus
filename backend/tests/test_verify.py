"""Verify before done: finishing with code that nothing ran or opened is sent back once, with how to check it."""
from __future__ import annotations

from app.llm.router import set_provider_override
from conftest import NativeScriptedProvider, agent, edge, make_company, start_run, wait_status

ON = {"verify_before_finish": True}


def outs(req):  # type: ignore[no-untyped-def]
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


async def test_unverified_code_is_sent_back_once_then_finish_after_running_it(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"path": "app.py", "content": "print('hi')\n"})],
        [("finish", {"summary": "done"})],               # sent back: nothing ran app.py
        [("run_code", {"command": "python app.py"})],
        [("finish", {"summary": "ran it: prints hi"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and "prints hi" in (done["summary"] or "")
    bounce = outs(provider.requests[2])[-1]
    assert "Not finished yet: verify first" in bounce and "app.py" in bounce and "run_code" in bounce
    assert len(provider.requests) == 4, "the bounce kept the turn going instead of ending it"


async def test_bounce_happens_once_and_a_second_finish_is_accepted(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [
        [("write_file", {"path": "app.py", "content": "print('hi')\n"})],
        [("finish", {"summary": "done"})], [("finish", {"summary": "can't verify here"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and "can't verify" in (done["summary"] or "")


async def test_delegated_builder_is_also_asked_to_verify(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "write app.py"})], [("finish", {"summary": "ok"})]],
        "Ben": [[("write_file", {"path": "app.py", "content": "print(1)\n"})], [("finish", {"summary": "written"})],
                [("run_code", {"command": "python app.py"})], [("finish", {"summary": "written and ran: prints 1"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("ab", "a", "b")])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    ann_last = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann"][-1]
    assert "prints 1" in outs(ann_last)[-1]


async def test_text_only_changes_finish_directly(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [[("write_file", {"path": "notes.md", "content": "# hi"})], [("finish", {"summary": "done"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and len(provider.requests) == 2
