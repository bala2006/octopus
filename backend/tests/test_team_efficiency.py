"""Less coordination, more shared knowledge: delegation with results, parallel work, team digest, project search & memory."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

from app.llm.base import LLMChunk, LLMRequest
from app.llm.router import set_provider_override
from app.services import project_memory as PM
from app.tools.workspace import ProjectFS
from conftest import NativeScriptedProvider, ScriptedProvider, agent, edge, env, events, make_company, run_messages, start_run, wait_status

TEAM = [agent("a", "Ann", entry=True), agent("b", "Ben"), agent("c", "Cy")]
EDGES = [edge("ab", "a", "b"), edge("ac", "a", "c")]


def outputs_of(req: LLMRequest) -> list[str]:
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


async def tasks(client, ws, run_id):  # type: ignore[no-untyped-def]
    return (await client.get(f"/api/v1/w/{ws['id']}/runs/{run_id}/tasks")).json()


async def test_delegation_returns_the_teammates_result_in_the_same_turn(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "Write hello.txt saying hi", "deliverable": "hello.txt",
                               "done_when": "the file exists"})],
                lambda ctx, outs: [("finish", {"summary": "shipped: " + outs[-1].splitlines()[0]})]],
        "Ben": [[("write_file", {"path": "hello.txt", "content": "hi"})], [("finish", {"summary": "hello.txt written"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    assert (Path(workspace["path"]) / "hello.txt").read_text() == "hi"
    assert done["turns"] == 2, "Ann's turn plus Ben's delegated sub-turn; no messages back and forth"
    result = outputs_of(provider.requests[-1])[-1]
    assert result.startswith("Result from Ben (T-1 is done):") and "hello.txt written" in result and "hello.txt (v1)" in result
    assert [t["status"] for t in await tasks(client, workspace, run["id"])] == ["done"]
    ben_brief = next(r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ben").messages[-1]["content"]
    assert "Objective: Write hello.txt saying hi" in ben_brief and "Done when: the file exists" in ben_brief
    assert "request_user_input" not in {t["name"] for t in provider.requests[1].tools}, "a delegated teammate answers to its delegator"
    msgs = await run_messages(client, workspace, run["id"])
    assert any(m["meta"].get("delegation") for m in msgs) and any(m["meta"].get("delegation_result") for m in msgs)
    report = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/report")).text
    assert "## Efficiency" in report and "Delegations: 1" in report


class BarrierProvider(NativeScriptedProvider):
    """Ben and Cy each wait for the other before answering: this only finishes if they run at the same time."""

    def __init__(self, *a, **kw) -> None:  # type: ignore[no-untyped-def]
        super().__init__(*a, **kw)
        self.barrier = asyncio.Barrier(2)

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        ctx = req.metadata.get("mock_context")
        if ctx and ctx["agent"]["name"] in ("Ben", "Cy") and not req.continuation:
            await asyncio.wait_for(self.barrier.wait(), 5)
        async for ch in super().stream(req):
            yield ch


async def test_several_delegations_in_one_reply_run_in_parallel(client, workspace) -> None:
    provider = BarrierProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "Write a.txt"}), ("delegate", {"to": "Cy", "objective": "Write b.txt"})],
                [("finish", {"summary": "both done"})]],
        "Ben": [[("write_file", {"path": "a.txt", "content": "A"})], [("finish", {"summary": "a done"})]],
        "Cy": [[("write_file", {"path": "b.txt", "content": "B"})], [("finish", {"summary": "b done"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"], timeout=20)
    assert done["status"] == "completed", done["halt_reason"]
    root = Path(workspace["path"])
    assert (root / "a.txt").read_text() == "A" and (root / "b.txt").read_text() == "B"
    outs = outputs_of(provider.requests[-1])
    assert any(o.startswith("Result from Ben") for o in outs) and any(o.startswith("Result from Cy") for o in outs)
    assert done["state"]["metrics"]["parallel_delegations"] == 2


async def test_delegation_without_native_tools_becomes_a_task_message(client, workspace) -> None:
    """JSON-envelope path (e.g. the offline demo): a delegation is a structured task message the teammate picks up next."""
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "delegate", "to": "Ben", "objective": "Write c.txt", "done_when": "c.txt exists"})],
                                            "Ben": [env({"action": "write_file", "path": "c.txt", "content": "C"})]}))
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    assert (Path(workspace["path"]) / "c.txt").read_text() == "C"
    task_msgs = [m for m in await run_messages(client, workspace, run["id"]) if m["type"] == "task" and m["to_agent_id"] == "b"]
    assert task_msgs and task_msgs[0]["content"] == "Objective: Write c.txt\nDone when: c.txt exists"


async def test_ben_cannot_delegate_without_a_channel(client, workspace) -> None:
    def ann(ctx, outs):  # type: ignore[no-untyped-def]
        return [("delegate", {"to": "Ben", "objective": "ask Cy for a.txt"})]

    provider = NativeScriptedProvider({
        "Ann": [ann, [("finish", {"summary": "ok"})]],
        "Ben": [[("delegate", {"to": "Cy", "objective": "x"})],
                lambda ctx, outs: [("finish", {"summary": outs[-1]})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    result = outputs_of(provider.requests[-1])[-1]
    assert "Not delegated:" in result, "Ben has no delegate channel to Cy; he is told so and his summary carries it back"


async def test_team_digest_tells_an_agent_what_teammates_did(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("send_message", {"to": "Ben", "type": "task", "content": "please write notes.md"}), ("wait", {})],
                [("finish", {"summary": "ok"})]],
        "Ben": [[("write_file", {"path": "notes.md", "content": "# notes", "note": "first draft"}),
                 ("update_task_board", {"tasks": [{"key": "T-1", "status": "done"}]}),
                 ("send_message", {"to": "Ann", "type": "status_update", "content": "notes.md done"})], [("wait", {})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES + [edge("ba", "b", "a", "report")])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    ann_second = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann"][-1]
    user = ann_second.messages[-1]["content"]
    assert "# Team activity since your last turn" in user
    assert "Ben: created notes.md (v1): first draft" in user and "Ben: task board: T-1 → done" in user


def test_search_project(tmp_path: Path) -> None:
    fs = ProjectFS(tmp_path)
    fs.write("src/game.js", "const SPEED = 4;\nfunction jump() {}\n")
    fs.write(".octopus/work/spec.md", "Jump height: 2 tiles\n")
    hits, total, n = fs.search("jump")
    assert total == 2 and n == 2 and "src/game.js:2: function jump() {}" in hits and ".octopus/work/spec.md:1: Jump height: 2 tiles" in hits
    assert fs.search("Jump")[1] == 1, "an uppercase letter makes it case-sensitive"
    assert fs.search(r"SPEED\s*=\s*\d", regex=True)[0] == ["src/game.js:1: const SPEED = 4;"]
    assert fs.search("jump", prefix="src")[1] == 1


async def test_project_memory_carries_over_to_the_next_run(client, workspace) -> None:
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "remember", "key": "style", "value": "Use tabs in JS", "scope": "project"},
                                                        {"action": "finish", "summary": "built the menu"})]}))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    first = await start_run(client, workspace, cid, goal="Build the menu")
    await wait_status(client, workspace, first["id"])
    mem = PM.load(Path(workspace["path"]))
    assert mem["notes"]["style"]["value"] == "Use tabs in JS" and mem["runs"][-1]["goal"] == "Build the menu"
    assert mem["runs"][-1]["summary"] == "built the menu"

    provider = NativeScriptedProvider({"Ann": [[("finish", {"summary": "ok"})]]})
    set_provider_override(provider)
    second = await start_run(client, workspace, cid, goal="Add a settings page")
    await wait_status(client, workspace, second["id"])
    system = provider.requests[0].messages[0]["content"]
    assert "## Project memory (shared by the whole team, kept across runs)" in system
    assert "style: Use tabs in JS" in system and '"Build the menu": completed' in system and "built the menu" in system


async def test_small_team_templates(client, workspace) -> None:
    tpls = {t["key"]: t for t in (await client.get("/api/v1/templates")).json()}
    assert tpls["solo_engineer"]["agent_count"] == 1 and tpls["engineer_reviewer"]["agent_count"] == 2
    r = await client.post(f"/api/v1/w/{workspace['id']}/companies/from-template", json={"template_key": "solo_engineer"})
    canvas = r.json()
    assert [a["name"] for a in canvas["agents"]] == ["Sam"] and canvas["agents"][0]["tools"]["terminal"] is True
    run = (await client.post(f"/api/v1/w/{workspace['id']}/runs", json={"company_id": canvas["company"]["id"], "goal": "Build a todo app",
                                                                        "budget": {"force_mock": True}})).json()
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    assert json.dumps(done["state"]["metrics"])  # efficiency is recorded for every run
    assert done["state"]["metrics"]["turns"] >= 1


# ------------------------------------------------------------------ benchmark harness
def test_bench_checks(tmp_path: Path) -> None:
    from app.services.bench import evaluate, setup_project

    setup_project(tmp_path, {"files": {"a.py": "print('hi')\n"}})
    res = evaluate(tmp_path, [{"type": "file_exists", "path": "a.py"}, {"type": "file_contains", "path": "a.py", "text": ["print", "hi"]},
                              {"type": "command", "cmd": "python a.py", "stdout_contains": ["hi"]},
                              {"type": "command", "cmd": "python -c \"raise SystemExit(1)\""}, {"type": "file_exists", "path": "b.py"}])
    assert [r["ok"] for r in res] == [True, True, True, False, False]


async def test_bench_case_end_to_end(client, tmp_root: Path) -> None:
    """The harness opens a fresh project, seeds it, runs a template, checks the folder and reports efficiency."""
    from app.services.bench import run_case, summarize

    set_provider_override(None)
    tasks = json.loads((Path(__file__).resolve().parents[2] / "bench" / "tasks.json").read_text())
    task = next(t for t in tasks if t["id"] == "fix-failing-tests")
    res = await run_case(client, folder=tmp_root / f"bench-{tmp_root.stat().st_ino}", template="solo_engineer", task=task,
                         budget={"force_mock": True, "max_turns": 20}, timeout_s=60)
    assert res["status"] == "completed" and res["checks"] == 2
    assert res["passed"] is False and res["check_results"][1]["ok"] is True, "the mock doesn't fix bugs; the seeded test file is intact"
    assert res["turns"] >= 1 and res["overhead_share"] is not None
    table = summarize([res])
    assert "| solo_engineer | fix-failing-tests | ❌ | 1/2 |" in table and "| solo_engineer | 0/1 |" in table
