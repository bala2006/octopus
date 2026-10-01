"""Nothing in the model-facing path silently degrades what a model sees or produces (issue #36, docs/MODEL_QUALITY_AUDIT.md)."""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

from app.llm import router
from app.llm.azure_v1 import _body
from app.llm.base import LLMChunk, LLMRequest, Usage
from app.llm.router import prepare_request, set_provider_override
from app.orchestrator.actions import MAX_ACTIONS, parse_envelope
from app.orchestrator.context import TOOL_RESULT_CHARS, build_user_prompt, fmt_msg
from app.orchestrator.engine import head_tail, judge_verdict
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status


async def test_unknown_model_is_substituted_with_a_warning(monkeypatch) -> None:
    async def creds(db, user_id, provider):  # type: ignore[no-untyped-def]
        return "key", "https://res.openai.azure.com", {"deployments": ["gpt-6-luna", "gpt-6-mini"]}

    monkeypatch.setattr(router, "resolve_credentials", creds)
    req, warn = await prepare_request(None, "u", LLMRequest(provider="openai", model="gpt-4.1-mini", messages=[]))  # type: ignore[arg-type]
    assert req.model == "gpt-6-luna" and warn and "gpt-4.1-mini" in warn and "gpt-6-luna" in warn
    req, warn = await prepare_request(None, "u", LLMRequest(provider="azure", model="gpt-6-mini", messages=[]))  # type: ignore[arg-type]
    assert req.model == "gpt-6-mini" and warn is None


def test_reasoning_headroom_scales_with_effort() -> None:
    def budget(effort: str | None) -> int:
        req = LLMRequest(provider="azure", model="m", messages=[], max_tokens=8000, extra={"reasoning_effort": effort} if effort else {})
        return _body(req, "responses", set())["max_output_tokens"]

    assert budget(None) == budget("medium") == 8000 + 4096
    assert budget("none") == 8000, "no thinking, no headroom"
    assert budget("low") < budget("medium") < budget("high") < budget("xhigh"), "more thinking never shrinks the answer budget"


def test_long_tool_results_and_messages_are_marked_not_silently_cut() -> None:
    from app.orchestrator.context import AgentSpec

    a = AgentSpec.from_dict({"id": "a", "name": "Ann"}, "generic")
    big = "x" * (TOOL_RESULT_CHARS + 5000)
    prompt = build_user_prompt(agent=a, history=[], inbox_ids=set(), observations=[{"tool": "read_file", "ok": True, "content": big}],
                               blackboard="", names={}, recent_n=10)
    assert f"[truncated: showing {TOOL_RESULT_CHARS:,} of {len(big):,} characters" in prompt
    assert "offset" in prompt, "a cut file read tells the agent how to get the rest"
    m = {"from": "b", "to": "a", "type": "task", "content": "y" * 3000, "turn": 1, "meta": {}}
    assert "[truncated: 1,500 of 3,000 chars]" in fmt_msg(m, {"b": "Ben"}, "a", 1500)


async def test_read_file_returns_big_files_in_pages(client, workspace) -> None:
    text = "".join(f"line {i:05d}\n" for i in range(3000))  # 33,000 chars
    (Path(workspace["path"]) / "big.txt").write_text(text)
    seen: list[str] = []

    def capture(next_action):  # type: ignore[no-untyped-def]
        def step(ctx):  # type: ignore[no-untyped-def]
            seen.append(next(o["content"] for o in ctx["observations"] if o.get("tool") == "read_file"))
            return env(next_action)
        return step

    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "read_file", "path": "big.txt"}),
                                                    capture({"action": "read_file", "path": "big.txt", "offset": 11500}),
                                                    capture({"action": "finish", "summary": "read it"})]}))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    assert len(seen) == 2
    assert seen[0].startswith("big.txt [characters 0-11,500 of 33,000; read_file with \"offset\": 11500 for the next part]")
    assert seen[1].startswith("big.txt [characters 11,500-23,000 of 33,000") and "\nline 01046\n" in seen[1]
    assert text[11500:23000] in seen[1], "the page is exactly the requested slice"
    assert "[truncated" not in seen[0], "a page fits in the prompt without a further silent cut"


def test_judge_verdict_treats_non_answers_as_unknown() -> None:
    assert judge_verdict("YES") is True and judge_verdict(" no.") is False and judge_verdict("Yes, because…") is True
    assert judge_verdict("") is None and judge_verdict("Maybe") is None and judge_verdict("NOT SURE") is None


class SilentJudge(ScriptedProvider):
    async def stream(self, req: LLMRequest) -> AsyncIterator[LLMChunk]:
        if req.metadata.get("mock_context") is None:  # the condition judge: returns nothing at all
            yield LLMChunk(usage=Usage(1, 1, 0.0))
            return
        async for ch in super().stream(req):
            yield ch


async def test_unanswered_condition_is_delivered_with_a_warning(client, workspace) -> None:
    agents = [agent("a", "Ann", entry=True), agent("b", "Ben")]
    cid = await make_company(client, workspace, agents, [edge("e", "a", "b", "delegate", condition="when the spec is approved")])
    set_provider_override(SilentJudge({"Ann": [env(msg("Ben", "task", "Build it"))]}))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    assert any(m["to_agent_id"] == "b" for m in await run_messages(client, workspace, run["id"]))
    warn = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "warning"]
    assert any("could not be evaluated (no answer)" in w for w in warn)


async def test_invalid_actions_are_visible_in_the_run(client, workspace) -> None:
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": [env({"action": "write_file", "path": "a.txt"},  # no content
                                                        {"action": "finish", "summary": "done"})]}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    errs = [e["payload"] for e in await events(client, workspace, run["id"], "error") if e["payload"].get("kind") == "parse"]
    assert errs and "ignored 1 invalid action" in errs[0]["message"] and "write_file" in errs[0]["message"]


def test_actions_beyond_the_cap_are_reported() -> None:
    res = parse_envelope(json.dumps({"actions": [{"action": "wait"}] * (MAX_ACTIONS + 3)}))
    assert len(res.actions) == MAX_ACTIONS and any(f"{MAX_ACTIONS + 3} actions" in e for e in res.errors)


def test_repair_prompt_keeps_both_ends_of_a_long_reply() -> None:
    reply = "{" + "a" * 10_000 + "BROKEN_END"
    kept = head_tail(reply, 6000)
    assert kept.startswith("{") and kept.endswith("BROKEN_END") and "characters omitted" in kept and len(kept) < 6100
    assert head_tail("short", 6000) == "short"
