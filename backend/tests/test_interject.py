"""Talking to a live run: a message to everyone is one message, it resumes a paused run, and failed turns don't lose messages."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

from app.llm.base import LLMChunk, LLMError, LLMRequest
from app.llm.router import set_provider_override
from conftest import ScriptedProvider, agent, edge, events, make_company, run_messages, start_run, wait_status

NOTE = "Please use TypeScript for everything"


class Recording(ScriptedProvider):
    """Remembers the user prompt each agent saw."""

    def __init__(self, *a: Any, **kw: Any) -> None:
        super().__init__(*a, **kw)
        self.prompts: list[tuple[str, str]] = []

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        ctx = req.metadata.get("mock_context")
        if ctx is not None:
            self.prompts.append((ctx["agent"]["name"], str(req.messages[-1]["content"])))
        async for ch in super().stream(req):
            yield ch


async def _paused_team(client, workspace, provider) -> tuple[dict[str, Any], str]:  # type: ignore[no-untyped-def]
    agents = [agent("a", "Ann", entry=True), agent("b", "Ben"), agent("c", "Cat")]
    cid = await make_company(client, workspace, agents, [edge("e1", "a", "b"), edge("e2", "a", "c")])
    set_provider_override(provider)
    run = await start_run(client, workspace, cid, mode="step")  # parks before the first turn
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    return run, base


async def test_message_to_everyone_is_shown_once_but_reaches_every_agent(client, workspace) -> None:
    rec = Recording()
    run, base = await _paused_team(client, workspace, rec)
    assert (await client.post(f"{base}/interject", json={"content": NOTE})).status_code == 202
    for _ in range(3):
        await client.post(f"{base}/control/step")
        await asyncio.sleep(0.15)

    shown = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "message_created")
             if e["payload"]["message"]["type"] == "user_interjection"]
    assert len(shown) == 1, "one feed / timeline entry, not one per agent"
    assert shown[0]["to_agent_id"] is None and shown[0]["meta"]["recipients"] == 3
    listed = [m for m in await run_messages(client, workspace, run["id"]) if m["type"] == "user_interjection"]
    assert len(listed) == 1 and listed[0]["to_agent_id"] is None, "the message list agrees with the live feed"

    seen = {name for name, prompt in rec.prompts if NOTE in prompt.split("# NEW messages for you", 1)[-1]}
    assert seen == {"Ann", "Ben", "Cat"}, "each agent still gets it as a new message"
    ann = next(p for n, p in rec.prompts if n == "Ann" and NOTE in p)
    assert "everyone (3 agents, you included)" in ann, "the agent knows the whole team got the same message"
    await client.post(f"{base}/control/stop")


async def test_message_resumes_a_paused_run(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True, max_auto=200)]
    cid = await make_company(client, workspace, agents, [])
    set_provider_override(ScriptedProvider())
    run = await start_run(client, workspace, cid, budget={"max_turns": 400})
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await client.post(f"{base}/control/pause")
    await wait_status(client, workspace, run["id"], {"paused", *("completed", "incomplete")})
    if (await client.get(base)).json()["status"] != "paused":
        return  # finished before the pause landed: nothing to resume (covered by the continue tests)
    await client.post(f"{base}/interject", json={"content": "continue"})
    d = await wait_status(client, workspace, run["id"], {"running", "completed", "incomplete"})
    assert d["status"] != "paused", "saying continue used to leave the run paused until Resume was pressed"


async def test_message_in_step_mode_does_not_take_a_turn_by_itself(client, workspace) -> None:
    run, base = await _paused_team(client, workspace, ScriptedProvider())
    await client.post(f"{base}/interject", json={"content": NOTE, "to_agent_id": "b"})
    await asyncio.sleep(0.3)
    d = (await client.get(base)).json()
    assert d["status"] == "paused" and d["turns"] == 0, "step mode still waits for Next turn"
    await client.post(f"{base}/control/stop")


class FailsOnce(ScriptedProvider):
    """Ben's first model call fails; later calls work."""

    def __init__(self) -> None:
        super().__init__()
        self.failed = False
        self.ben_prompts: list[str] = []

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        ctx = req.metadata.get("mock_context")
        if ctx is not None and ctx["agent"]["name"] == "Ben":
            self.ben_prompts.append(str(req.messages[-1]["content"]))
            if not self.failed:
                self.failed = True
                raise LLMError("content filter tripped", retryable=False)
        async for ch in super().stream(req):
            yield ch


async def test_failed_turn_keeps_its_messages_new(client, workspace) -> None:
    """Regression: a failed model call marked the inbox read, so the next turn no longer showed what the agent was asked."""
    p = FailsOnce()
    agents = [agent("a", "Ann", entry=True), agent("b", "Ben")]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b")])
    set_provider_override(p)
    run = await start_run(client, workspace, cid, mode="step")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    await client.post(f"{base}/interject", json={"content": NOTE, "to_agent_id": "b"})
    for _ in range(4):
        await client.post(f"{base}/control/step")
        await asyncio.sleep(0.15)
        if len(p.ben_prompts) >= 2:
            break
    assert len(p.ben_prompts) >= 2
    new = p.ben_prompts[1].split("# NEW messages for you", 1)[-1]
    assert NOTE in new, "the retry turn still has the user's message as new"
    assert "shown again under NEW messages" in p.ben_prompts[1]
    await client.post(f"{base}/control/stop")
