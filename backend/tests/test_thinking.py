"""The agents' thinking is visible: reasoning summaries are requested, streamed live and kept in the run log."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from app.llm.azure_v1 import AzureV1Provider, _body, _dropped
from app.llm.base import LLMChunk, LLMRequest
from app.llm.router import set_provider_override
from conftest import NativeScriptedProvider, agent, events, make_company, start_run, wait_status


def _req(effort: str | None = "xhigh") -> LLMRequest:
    return LLMRequest(provider="azure", model="gpt-6-luna", messages=[{"role": "user", "content": "hi"}], api_key="k",
                      base_url="https://res-think.openai.azure.com", extra={"reasoning_effort": effort} if effort else {})


def test_reasoning_summary_is_requested_with_the_effort() -> None:
    assert _body(_req("xhigh"), "responses", set())["reasoning"] == {"summary": "auto", "effort": "xhigh"}
    assert "summary" not in _body(_req("none"), "responses", set()).get("reasoning", {}), "no reasoning, nothing to summarise"
    assert _body(_req("xhigh"), "responses", {"reasoning.summary"})["reasoning"] == {"effort": "xhigh"}


async def test_summary_streams_as_thinking_and_text_stays_separate() -> None:
    sse = "".join(f"data: {json.dumps(e)}\n\n" for e in [
        {"type": "response.reasoning_summary_text.delta", "delta": "**Planning the game loop**\n\nI'll use"},
        {"type": "response.reasoning_summary_text.delta", "delta": " requestAnimationFrame."},
        {"type": "response.reasoning_summary_part.done"},
        {"type": "response.output_text.delta", "item_id": "m", "delta": "done"},
        {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 1}}}]).encode()
    p = AzureV1Provider(httpx.MockTransport(lambda r: httpx.Response(200, content=sse, headers={"content-type": "text/event-stream"})))
    chunks = [c async for c in p.stream(_req())]
    assert "".join(c.thinking for c in chunks) == "**Planning the game loop**\n\nI'll use requestAnimationFrame.\n\n"
    assert "".join(c.delta for c in chunks) == "done"


async def test_deployment_without_summaries_keeps_its_reasoning_effort() -> None:
    sent: list[dict] = []

    def handler(r: httpx.Request) -> httpx.Response:
        body = json.loads(r.content)
        sent.append(body)
        if "summary" in (body.get("reasoning") or {}):
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter: 'reasoning.summary'", "param": "reasoning.summary"}})
        ok = "".join(f"data: {json.dumps(e)}\n\n" for e in [{"type": "response.output_text.delta", "item_id": "m", "delta": "ok"},
                                                            {"type": "response.completed", "response": {"usage": {}}}])
        return httpx.Response(200, content=ok.encode(), headers={"content-type": "text/event-stream"})

    _dropped.clear()
    chunks = [c async for c in AzureV1Provider(httpx.MockTransport(handler)).stream(_req())]
    assert "".join(c.delta for c in chunks) == "ok"
    assert sent[-1]["reasoning"] == {"effort": "xhigh"}, "only the summary was dropped, the effort stays"


class ThinkingProvider(NativeScriptedProvider):
    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        if req.metadata.get("mock_context") is not None:
            for part in ("**Checking the board**\n\n", "Nothing is open, ", "so I can finish."):
                yield LLMChunk(thinking=part)
        async for ch in super().stream(req):
            yield ch


async def test_engine_streams_and_keeps_the_thought(client, workspace) -> None:
    from app.orchestrator.bus import EPHEMERAL

    assert "thinking_stream" in EPHEMERAL, "live deltas aren't persisted one by one"
    set_provider_override(ThinkingProvider({"Ann": [[("finish", {"summary": "ok"})]]}))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    thoughts = [e["payload"] for e in await events(client, workspace, run["id"], "thought")]
    assert thoughts and thoughts[0]["kind"] == "reasoning"
    assert thoughts[0]["text"] == "**Checking the board**\n\nNothing is open, so I can finish."


class SlowThinker(NativeScriptedProvider):
    """Streams thinking for longer than the idle timeout, but never goes quiet for that long."""

    def __init__(self, script, gap: float, chunks: int) -> None:
        super().__init__(script)
        self.gap, self.chunks = gap, chunks

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        import asyncio

        if req.metadata.get("mock_context") is not None:
            for i in range(self.chunks):
                await asyncio.sleep(self.gap)
                yield LLMChunk(thinking=f"step {i}. ")
        async for ch in super().stream(req):
            yield ch


async def test_long_call_that_keeps_streaming_is_not_cut_off(client, workspace, monkeypatch) -> None:
    from app.orchestrator import engine

    monkeypatch.setattr(engine, "LLM_IDLE_TIMEOUT_S", 0.4)
    set_provider_override(SlowThinker({"Ann": [[("finish", {"summary": "ok"})]]}, gap=0.1, chunks=10))  # ~1s in total
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    assert not [e for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "llm"]
    assert (await events(client, workspace, run["id"], "thought"))[0]["payload"]["text"].startswith("step 0. step 1.")


async def test_silent_call_times_out_with_a_clear_reason(client, workspace, monkeypatch) -> None:
    from app.orchestrator import engine

    monkeypatch.setattr(engine, "LLM_IDLE_TIMEOUT_S", 0.3)
    set_provider_override(SlowThinker({"Ann": [[("finish", {"summary": "ok"})]] * 4}, gap=0.8, chunks=1))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    errors = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error")]
    assert any("no output from the model" in m for m in errors), errors
