"""Budgets, loop detection, pause/step/stop and interjection reliably control runs."""
from __future__ import annotations

import asyncio
import itertools
import random

from app.llm.router import set_provider_override
from app.orchestrator.protocols import LoopDetector
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status


WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo "
         "sierra tango uniform victor whiskey xray yankee zulu amber basalt cobalt dune ember fjord glacier harbor iris jade").split()


def pingpong(company: tuple[str, str]):  # type: ignore[no-untyped-def]
    """Two agents that keep messaging each other with genuinely different content (never a loop, never progress)."""
    counter = itertools.count()
    rng = random.Random(7)

    def reply(ctx):  # type: ignore[no-untyped-def]
        other = company[1] if ctx["agent"]["name"] == company[0] else company[0]
        return env(msg(other, "question", f"Q{next(counter)}: " + " ".join(rng.sample(WORDS, 7)) + "?"))

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
    chatter = pingpong(("Ann", "Ben"))

    def nagging(ctx):  # type: ignore[no-untyped-def]  # keeps the conversation alive AND keeps re-asking the same thing
        other = "Ben" if ctx["agent"]["name"] == "Ann" else "Ann"
        return env(chatter(ctx)["actions"][0], msg(other, "status_update", "Are we done yet?"))

    set_provider_override(ScriptedProvider(default=nagging))
    run = await start_run(client, workspace, cid, budget={"max_turns": 60, "max_loop_strikes": 3})
    paused = await wait_status(client, workspace, run["id"], {"paused", "failed", "completed"})
    assert paused["status"] == "paused"
    errs = [e["payload"] for e in await events(client, workspace, run["id"], "error")]
    assert any(e.get("kind") == "loop" and "paused" in e["message"] for e in errs)
    assert len([e for e in errs if e.get("kind") == "loop"]) == 4, "3 strikes, then the pause"
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    # resuming keeps the evidence: the very next repeat pauses the run again (strikes used to be wiped on resume)
    await client.post(f"{base}/control/resume")
    await wait_status(client, workspace, run["id"], {"running"})
    again = await wait_status(client, workspace, run["id"], {"paused", "failed", "completed"})
    assert again["status"] == "paused"
    pauses = [e for e in (await events(client, workspace, run["id"], "error")) if "paused" in e["payload"]["message"]]
    assert len(pauses) == 2
    await client.post(f"{base}/control/stop")
    assert (await wait_status(client, workspace, run["id"]))["status"] == "cancelled"


def test_loop_detector_catches_reworded_requests() -> None:
    """Regression: seven rephrased asks for the same brief never tripped the character-level detector."""
    asks = [
        "Please send me the completed proposed track brief for review when ready, including hazard sequence/spacing, perspective assumptions, landmarks, and difficulty ramp.",
        "Please send the completed short-trail brief for review now, including obstacle sequence/spacing, landmarks and the difficulty ramp.",
        "Please deliver the compact track brief now for review and inclusion in /design/track_briefs.md, with hazard spacing, landmarks and difficulty ramp.",
    ]
    ld = LoopDetector()
    assert not ld.check("riley", "jordan", "question", asks[0])
    assert ld.check("riley", "jordan", "question", asks[1]) and "reworded" in ld.last_reason
    assert ld.check("riley", "jordan", "status_update", asks[2])
    # different work on the same channel is not a loop, nor is the same ask to someone else
    assert not ld.check("riley", "jordan", "task", "Implement the player movement in main.js: WASD controls, jumping with gravity and collisions.")
    assert not ld.check("riley", "jordan", "task", "Implement the player jumping in main.js: SPACE controls, jumping with gravity and collisions."), \
        "similar-but-distinct delegations are not intent loops"
    assert not ld.check("riley", "sam", "question", asks[1])
    # protocol messages are never compared by intent (a review round naturally reuses the same vocabulary)
    assert not ld.check("riley", "jordan", "review_request", asks[2])


def test_loop_detector_catches_cycles_across_pairs() -> None:
    text = "Can someone confirm whether the final index.html candidate exists and where it is stored?"
    ld = LoopDetector()
    assert not ld.check("a", "b", "question", text)
    assert not ld.check("b", "c", "question", text)  # forwarding once is fine
    assert ld.check("c", "a", "question", text) and "circling" in ld.last_reason


def test_loop_strikes_survive_resume() -> None:
    ld = LoopDetector(max_strikes=2)
    ld.check("a", "b", "question", "status?")
    ld.check("a", "b", "question", "status?")
    ld.check("a", "b", "question", "status?")
    assert ld.escalate()
    ld = LoopDetector.from_dict(ld.to_dict())
    ld.acknowledge(hot=True)
    assert not ld.escalate() and ld.total_strikes() == 2
    ld.check("a", "b", "question", "status?")
    assert ld.escalate(), "one new strike after a human resumed is enough"
    ld.acknowledge(hot=False)  # a new follow-up: needs max_strikes new strikes again
    ld.check("a", "b", "question", "status?")
    assert not ld.escalate()
    assert LoopDetector.from_dict({"threshold": 0.9, "window": 6, "max_strikes": 3, "recent": {}, "strikes": {"a": 1}}).total_strikes() == 1


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


async def test_follow_ups_cannot_compound_the_budget(client, workspace) -> None:
    """Regression: every follow-up layered a whole new base budget on top (N follow-ups = N x the agreed spend)."""
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider(default=env({"action": "finish", "summary": "done"}), tokens=500))  # 1000 tokens / turn
    run = await start_run(client, workspace, cid, budget={"max_tokens": 2000, "max_turns": 10, "max_cost_usd": 1.0})
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"])
    seen = []
    for i in range(6):
        r = await client.post(f"{base}/continue", json={"content": f"follow-up {i}"})
        assert r.status_code == 202
        d = await wait_status(client, workspace, run["id"])
        seen.append((d["budget"]["max_tokens"], d["budget"]["max_turns"], d["status"]))
    caps = [s[0] for s in seen]
    assert max(caps) == 2000 * 3, f"lifetime ceiling is 3x the base budget, got {caps}"
    assert caps == sorted(caps) and caps[-1] == caps[-2] == 6000, "headroom stops growing at the ceiling"
    assert all(s[1] <= 30 for s in seen)
    assert seen[-1][2] == "failed"
    assert "lifetime ceiling" in (await client.get(base)).json()["halt_reason"]


async def test_skipped_turns_cost_no_budget_and_are_visible(client, workspace) -> None:
    """Regression: turns over max_autonomous_turns were counted against max_turns without any turn_started event."""
    agents = [agent("a", "Ann", entry=True, max_auto=2), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, budget={"max_turns": 40})
    done = await wait_status(client, workspace, run["id"])
    started = await events(client, workspace, run["id"], "turn_started")
    skipped = await events(client, workspace, run["id"], "turn_skipped")
    assert done["turns"] == len(started), "every counted turn is visible in the timeline"
    assert skipped and skipped[0]["payload"]["agent_id"] == "a" and skipped[0]["payload"]["limit"] == 2


async def test_stall_watchdog_pauses_a_run_that_makes_no_progress(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200), agent("b", "Ben", max_auto=200)]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "consult", True, max_turns=500)])
    set_provider_override(ScriptedProvider(default=pingpong(("Ann", "Ben"))))
    run = await start_run(client, workspace, cid, budget={"max_turns": 200, "stall_turns": 10})
    paused = await wait_status(client, workspace, run["id"], {"paused", "failed", "completed"})
    assert paused["status"] == "paused" and paused["turns"] == 10
    stall = [e["payload"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "stall"]
    assert stall and "No progress for 10 turns" in stall[0]["message"]
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await client.post(f"{base}/control/resume")  # a human looked: the run gets another stall_turns before pausing again
    for _ in range(400):
        again = (await client.get(base)).json()
        if again["turns"] > 10 and again["status"] != "running":
            break
        await asyncio.sleep(0.02)
    assert again["status"] == "paused" and again["turns"] == 20
    await client.post(f"{base}/control/stop")
    await wait_status(client, workspace, run["id"])
