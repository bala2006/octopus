"""Budgets, loop detection, pause/step/stop and interjection reliably control runs."""
from __future__ import annotations

import asyncio
import itertools

from app.llm.router import set_provider_override
from app.orchestrator.protocols import LoopDetector
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status


def pingpong(company: tuple[str, str]):  # type: ignore[no-untyped-def]
    counter = itertools.count()

    def reply(ctx):  # type: ignore[no-untyped-def]
        other = company[1] if ctx["agent"]["name"] == company[0] else company[0]
        return env(msg(other, "question", f"Unique question number {next(counter)} about topic {next(counter) * 7919}"))

    return reply


async def test_max_turns_budget_halts_runaway(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, budget={"max_turns": 8})
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "failed" and "max turns" in done["halt_reason"]
    assert done["turns"] == 8


async def test_token_budget_halts(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben")), tokens=500))
    run = await start_run(client, workspace, cid, budget={"max_tokens": 3000, "max_turns": 500})
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "failed" and "token budget" in done["halt_reason"]
    assert done["tokens_used"] < 3000 + 1000


async def test_edge_max_turns(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=3)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, budget={"max_turns": 30})
    await wait_status(client, workspace, run["id"])
    sent = [m for m in await run_messages(client, workspace, run["id"]) if m["edge_id"] == "e"]
    assert len(sent) == 3
    assert any("turn limit" in e["payload"]["reason"] for e in await events(client, workspace, run["id"], "message_rejected"))


def test_loop_detector_unit() -> None:
    ld = LoopDetector(threshold=0.9, max_strikes=2)
    assert not ld.check("a", "b", "question", "What is the status of the build?")
    assert ld.check("a", "b", "question", "What is the status of the build ?")
    assert not ld.check("a", "b", "question", "Totally different: please deploy to staging")
    assert ld.check("a", "b", "question", "what is the status of the build?")
    assert ld.escalate()


async def test_loop_detector_pauses_run(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    same = lambda ctx: env(msg("Ben" if ctx["agent"]["name"] == "Ann" else "Ann", "question", "Are we done yet?"))  # noqa: E731
    set_provider_override(ScriptedProvider(default=same))
    run = await start_run(client, workspace, cid, budget={"max_turns": 60, "max_loop_strikes": 3})
    paused = await wait_status(client, workspace, run["id"], {"paused", "failed", "completed"})
    assert paused["status"] == "paused"
    errs = [e["payload"] for e in await events(client, workspace, run["id"], "error")]
    assert any(e.get("kind") == "loop" and "paused" in e["message"] for e in errs)
    await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/control/stop")
    assert (await wait_status(client, workspace, run["id"]))["status"] == "cancelled"


async def test_step_mode_and_interject_and_stop(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, mode="step")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    assert (await client.get(base)).json()["turns"] == 0
    for n in (1, 2):
        await client.post(f"{base}/control/step")
        for _ in range(200):
            d = (await client.get(base)).json()
            if d["turns"] == n and d["status"] == "paused":
                break
            await asyncio.sleep(0.02)
        assert d["turns"] == n
    r = await client.post(f"{base}/interject", json={"content": "Focus on security please", "to_agent_id": "b"})
    assert r.status_code == 202
    msgs = await run_messages(client, workspace, run["id"])
    assert any(m["type"] == "user_interjection" and m["to_agent_id"] == "b" for m in msgs)
    await client.post(f"{base}/control/stop")
    assert (await wait_status(client, workspace, run["id"]))["status"] == "cancelled"


async def test_pause_resume(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])

    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, budget={"max_turns": 400})
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await client.post(f"{base}/control/pause")
    d = await wait_status(client, workspace, run["id"], {"paused"})
    t = d["turns"]
    await asyncio.sleep(0.2)
    assert (await client.get(base)).json()["turns"] == t, "no turns while paused"
    await client.post(f"{base}/control/resume")
    await wait_status(client, workspace, run["id"], {"running", "failed"})
    await client.post(f"{base}/control/stop")
    assert (await wait_status(client, workspace, run["id"]))["status"] == "cancelled"
