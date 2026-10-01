"""The company workflow: intake → phases with owners → gates → the test/fix loop → acceptance by the head."""
from __future__ import annotations

from pathlib import Path

from app.llm.router import set_provider_override
from app.orchestrator.context import AgentSpec
from app.orchestrator.workflow import PHASES, can_staff, pick_owner
from conftest import NativeScriptedProvider, agent, events, make_company, run_messages, start_run, wait_status

REPORT = "# Test report\n| AC | result |\n|---|---|\n| AC1 game starts | {r} |\nCommand: python app.py -> printed ok\n"


def role(aid: str, name: str, key: str, title: str, **kw):  # type: ignore[no-untyped-def]
    return agent(aid, name, role=title, behavior={"template_key": key, "prompt_linked": True, "max_autonomous_turns": 30}, **kw)


TEAM = [role("h", "Ava", "ceo", "CEO", entry=True), role("b", "Sam", "fullstack_dev", "Software Engineer"), role("q", "Quinn", "qa", "QA Engineer")]
ON = {"workflow": "on"}


def outs(req):  # type: ignore[no-untyped-def]
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


def spec(d: dict) -> AgentSpec:  # type: ignore[type-arg]
    return AgentSpec.from_dict(d, "generic")


def test_owners_are_picked_by_role_and_tests_are_independent() -> None:
    team = [spec(a) for a in TEAM]
    assert pick_owner(team, PHASES["build"]).name == "Sam"
    assert pick_owner(team, PHASES["test"]).name == "Quinn"
    assert pick_owner(team, PHASES["spec"]) is None, "no product manager on this team: the spec phase is skipped"
    assert can_staff(team, team[0])
    assert not can_staff(team[:2], team[0]), "a builder alone can't be checked independently: auto stays free-form"
    titled = [spec(agent("x", "Lee", role="Backend Developer")), spec(agent("y", "Kim", role="QA Tester"))]
    assert pick_owner(titled, PHASES["build"]).name == "Lee" and pick_owner(titled, PHASES["test"]).name == "Kim"


async def test_quick_track_with_a_failed_test_loops_back_to_the_builder(client, workspace) -> None:  # type: ignore[no-untyped-def]
    provider = NativeScriptedProvider({
        "Ava": [[("set_track", {"track": "quick", "reason": "one script"})],
                [("finish", {"summary": "accepted: app.py prints ok, tests pass"})]],
        "Sam": [[("write_file", {"path": "app.py", "content": "print('ko')\n"})], [("run_code", {"command": "python app.py"})],
                [("finish", {"summary": "built app.py"})],
                [("write_file", {"path": "app.py", "content": "print('ok')\n"})], [("run_code", {"command": "python app.py"})],
                [("finish", {"summary": "fixed: prints ok"})]],
        "Quinn": [[("write_file", {"path": ".octopus/work/test-report.md", "content": REPORT.format(r="FAIL: prints ko")})],
                  [("finish", {"summary": "AC1 fails: prints ko instead of ok", "outcome": "fail"})],
                  [("write_file", {"path": ".octopus/work/test-report.md", "content": REPORT.format(r="pass")})],
                  [("finish", {"summary": "all pass", "outcome": "pass"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, [])
    run = await start_run(client, workspace, cid, goal="Write app.py that prints ok", permission_level="danger", budget=ON)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    assert (Path(workspace["path"]) / "app.py").read_text() == "print('ok')\n"
    wf = (await events(client, workspace, run["id"], "workflow_updated"))[-1]["payload"]["workflow"]
    assert wf["track"] == "quick" and [(p["key"], p["status"]) for p in wf["phases"]] == [
        ("intake", "done"), ("build", "done"), ("test", "done"), ("accept", "done")]
    assert next(p for p in wf["phases"] if p["key"] == "build")["loops"] == 1
    briefs = [m for m in await run_messages(client, workspace, run["id"]) if (m.get("meta") or {}).get("workflow_phase")]
    assert [m["meta"]["workflow_phase"] for m in briefs] == ["build", "test", "build", "test", "accept"]
    assert "Write app.py that prints ok" in briefs[0]["content"] and "implement-feature" in briefs[0]["content"]
    assert "FAILED" in briefs[2]["content"] and "prints ko instead of ok" in briefs[2]["content"]
    report = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/report")).text
    assert "## Workflow (quick track)" in report and "| Build | Sam | done | 1 |" in report
    head_first = next(r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ava")
    names = {t["name"] for t in head_first.tools}
    assert "set_track" in names and "delegate" not in names, "the head plans; the engine hands out the phases"


async def test_gate_sends_an_owner_back_when_its_document_is_missing(client, workspace) -> None:  # type: ignore[no-untyped-def]
    team = TEAM + [role("p", "Pia", "pm", "Product Manager")]
    provider = NativeScriptedProvider({
        "Ava": [[("set_track", {"track": "standard"})]],
        "Pia": [[("finish", {"summary": "spec done"})],  # no spec.md: sent back
                [("write_file", {"path": ".octopus/work/spec.md", "content": "# Spec\n## Acceptance criteria\nAC1. Given a start, when run, "
                                                                            "then it prints ok.\n## Non-goals\nNone.\n"})],
                [("finish", {"summary": "spec.md written"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, team, [])
    run = await start_run(client, workspace, cid, budget={**ON, "max_turns": 4})
    await wait_status(client, workspace, run["id"])
    pia = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Pia"]
    assert "isn't done yet" in outs(pia[1])[-1] and "spec.md" in outs(pia[1])[-1]
    wf = (await events(client, workspace, run["id"], "workflow_updated"))[-1]["payload"]["workflow"]
    statuses = {p["key"]: p["status"] for p in wf["phases"]}
    assert statuses["spec"] == "done" and statuses["design"] == "skipped" and statuses["build"] == "active"


async def test_off_and_demo_runs_stay_free_form(client, workspace) -> None:  # type: ignore[no-untyped-def]
    provider = NativeScriptedProvider({"Ava": [[("finish", {"summary": "ok"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, [])
    run = await start_run(client, workspace, cid)  # conftest default: workflow off
    await wait_status(client, workspace, run["id"])
    assert not await events(client, workspace, run["id"], "workflow_updated")
    assert "set_track" not in {t["name"] for t in provider.requests[0].tools}
