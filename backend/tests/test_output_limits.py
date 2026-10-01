"""Large deliverables: chunked writes, output-limit detection and automatic budget escalation (issue #26)."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from app.llm.azure_v1 import AzureV1Provider
from app.llm.base import LLMChunk, LLMOutputTruncated, LLMRequest, Usage
from app.llm.router import set_provider_override
from app.orchestrator.actions import WriteFile, parse_envelope
from app.prompts.roles import agent_from_role
from conftest import ScriptedProvider, agent, env, events, make_company, start_run, wait_status


async def canvas(client, ws, cid):  # type: ignore[no-untyped-def]
    return (await client.get(f"/api/v1/w/{ws['id']}/companies/{cid}")).json()


class TruncatingProvider(ScriptedProvider):
    """Behaves like a model whose replies are cut off whenever the answer budget is below ``needs`` tokens."""

    def __init__(self, needs: int, *args, **kw) -> None:  # type: ignore[no-untyped-def]
        super().__init__(*args, **kw)
        self.needs = needs
        self.budgets: list[int] = []

    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        if req.metadata.get("mock_context") is not None:
            self.budgets.append(req.max_tokens)
            if req.max_tokens < self.needs:
                yield LLMChunk(delta='{"thought": "writing the game", "actions": [{"action": "write_file", "path": "index.html", "content": "<html>')
                yield LLMChunk(usage=Usage(100, req.max_tokens, 0.001))
                raise LLMOutputTruncated("stopped at the output limit", partial="...")
        async for ch in super().stream(req):
            yield ch


def test_write_file_mode_parsing() -> None:
    res = parse_envelope(json.dumps({"actions": [{"action": "write_file", "path": "a.js", "content": "x", "mode": "a"},
                                                 {"action": "write_file", "path": "b.js", "content": "y"}]}))
    assert res.ok and [a.mode for a in res.actions] == ["append", "overwrite"]
    with pytest.raises(ValueError):
        WriteFile(action="write_file", path="a", content="", mode="prepend")


def test_code_roles_get_a_bigger_answer_budget() -> None:
    assert agent_from_role("gameplay_programmer")["max_tokens"] >= 16384
    assert agent_from_role("pm")["max_tokens"] >= 8192


async def test_large_file_is_built_in_parts(client, workspace) -> None:
    parts = ["<!doctype html>\n<html><body>\n", "<script>\nconst game = {};\n", "</script>\n</body></html>\n"]
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [
        env({"action": "write_file", "path": "game/index.html", "content": parts[0], "note": "part 1", "partial": True}),
        env({"action": "write_file", "path": "game/index.html", "content": parts[1], "mode": "append", "partial": True}),
        env({"action": "write_file", "path": "game/index.html", "content": parts[2], "mode": "append"}),
        env({"action": "finish", "summary": "game written"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    assert (Path(workspace["path"]) / "game/index.html").read_text() == "".join(parts)
    versions = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/artifacts?all_versions=true")).json()
    assert [v["version"] for v in versions if v["path"] == "game/index.html"] == [1, 2, 3]
    arts = [e["payload"]["artifact"] for e in await events(client, workspace, run["id"], "artifact_updated")]
    assert [a["appended"] for a in arts] == [False, True, True]


async def test_truncated_reply_raises_the_agent_budget_and_retries(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    provider = TruncatingProvider(16000, {"Ann": [
        env({"action": "write_file", "path": "index.html", "content": "<html>full game</html>"}),
        env({"action": "finish", "summary": "done"})]})
    set_provider_override(provider)
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    assert (Path(workspace["path"]) / "index.html").read_text() == "<html>full game</html>"
    assert provider.budgets[:2] == [8192, 16384], "first call at the default, retried once with a doubled budget"
    warn = [e["payload"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "warning"]
    assert any("output limit" in w["message"] for w in warn)
    ann = next(a for a in (await canvas(client, workspace, cid))["agents"] if a["id"] == "a")
    assert ann["max_tokens"] == 16384, "the higher limit is remembered on the agent"


async def test_reply_still_truncated_after_escalation_is_reported_not_applied(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(TruncatingProvider(10**9))
    run = await start_run(client, workspace, cid, permission_level="danger", budget={"max_turns": 2})
    await wait_status(client, workspace, run["id"])
    assert not (Path(workspace["path"]) / "index.html").exists(), "a cut-off write_file is never applied"
    errs = [e["payload"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "llm"]
    assert errs and "output limit" in errs[0]["message"]


async def test_agent_can_raise_its_own_output_budget(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [
        env({"action": "update_agent", "target": "self", "changes": {"max_tokens": 32000}, "reason": "big file ahead"}),
        env({"action": "finish", "summary": "ok"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    ann = next(a for a in (await canvas(client, workspace, cid))["agents"] if a["id"] == "a")
    assert ann["max_tokens"] == 32000


# ------------------------------------------------------------------ Azure provider: truncation is detected on both API styles
def _sse(*events: dict) -> bytes:
    return "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()


async def _collect(provider: AzureV1Provider, req: LLMRequest) -> tuple[str, list[Usage]]:
    text, usages = "", []
    async for ch in provider.stream(req):
        text += ch.delta
        if ch.usage:
            usages.append(ch.usage)
    return text, usages


def _req(url: str) -> LLMRequest:
    return LLMRequest(provider="azure", model="gpt-6-luna", messages=[{"role": "user", "content": "hi"}], api_key="k", base_url=url)


async def test_azure_responses_incomplete_raises_truncated_and_bills_usage() -> None:
    body = _sse({"type": "response.output_text.delta", "item_id": "m1", "delta": '{"actions": [{"action": "write_file"'},
                {"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"},
                                                             "usage": {"input_tokens": 10, "output_tokens": 6144}}})
    provider = AzureV1Provider(httpx.MockTransport(lambda r: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})))
    usages: list[Usage] = []
    with pytest.raises(LLMOutputTruncated) as exc:
        async for ch in provider.stream(_req("https://res.openai.azure.com/openai/v1/responses")):
            if ch.usage:
                usages.append(ch.usage)
    assert exc.value.partial.startswith('{"actions"')
    assert usages and usages[0].completion_tokens == 6144, "tokens spent on a cut-off reply are still accounted"


async def test_azure_chat_finish_reason_length_raises_truncated() -> None:
    body = _sse({"choices": [{"delta": {"content": '{"thought": "'}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "length"}]},
                {"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 100}})
    provider = AzureV1Provider(httpx.MockTransport(lambda r: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})))
    with pytest.raises(LLMOutputTruncated):
        await _collect(provider, _req("https://res.openai.azure.com/openai/v1/chat/completions"))


async def test_azure_complete_reply_is_not_flagged() -> None:
    body = _sse({"type": "response.output_text.delta", "item_id": "m1", "delta": "hello"},
                {"type": "response.completed", "response": {"usage": {"input_tokens": 3, "output_tokens": 1}}})
    provider = AzureV1Provider(httpx.MockTransport(lambda r: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})))
    text, usages = await _collect(provider, _req("https://res.openai.azure.com"))
    assert text == "hello" and usages[0].completion_tokens == 1
