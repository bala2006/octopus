"""Fixes for the "a multi-agent run does worse than one agent" failure mode: questions nobody can answer, silent tool-round exhaustion, blind edit retries, parallel work that depends on other work."""
from __future__ import annotations

from pathlib import Path

from app.plugins.providers.base import LLMRequest
from app.plugins.providers.router import set_provider_override
from app.kernel.runtime import engine as E
from app.kernel.runtime.context import build_system_prompt
from conftest import NativeScriptedProvider, agent, edge, events, make_company, run_messages, start_run, wait_status

TEAM = [agent("a", "Ann", entry=True), agent("b", "Ben"), agent("c", "Cy")]
EDGES = [edge("ab", "a", "b"), edge("bc", "b", "c", type_="consult", bidirectional=True), edge("ba", "b", "a", type_="report")]


def outputs_of(req: LLMRequest) -> list[str]:
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


async def test_delegated_worker_yields_for_peer_answer_then_returns_result_to_lead(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "Build index.html"})], [("finish", {"summary": "ok"})]],
        "Ben": [[("send_message", {"to": "Cy", "type": "question", "content": "What are the specs?"})],
                [("write_file", {"path": "index.html", "content": "<h1>game</h1>"})], [("finish", {"summary": "built"})]],
        "Cy": [[("send_message", {"to": "Ben", "type": "answer", "content": "Use the title game"}), ("wait", {})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    ben = [r for r in provider.requests if r.metadata["turn_context"]["agent"]["name"] == "Ben"]
    assert any(m["from"] == "Cy" and m["type"] == "answer" and m["content"] == "Use the title game"
               for m in ben[1].metadata["turn_context"]["inbox"])
    calls = [request.metadata["turn_context"]["agent"]["name"] for request in provider.requests]
    assert calls == ["Ann", "Ben", "Cy", "Ben", "Ben", "Ann"]
    messages = await run_messages(client, workspace, run["id"])
    assert [(m["from_agent_id"], m["to_agent_id"], m["type"], m["content"])
            for m in messages if m["type"] in ("question", "answer")] == [
        ("b", "c", "question", "What are the specs?"), ("c", "b", "answer", "Use the title game")]
    assert any(m["from_agent_id"] == "b" and m["to_agent_id"] == "a" and m["content"] == "built"
               and m["meta"].get("delegation_result") for m in messages)
    assert any(m["from"] == "Ben" and m["content"] == "built"
               for m in provider.requests[-1].metadata["turn_context"]["inbox"])
    assert (Path(workspace["path"]) / "index.html").read_text() == "<h1>game</h1>"
    assert not await events(client, workspace, run["id"], "message_rejected")


async def test_agent_is_told_to_wrap_up_before_its_tool_rounds_run_out(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [[("list_files", {})]] * 7})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, budget={"max_tool_rounds": 6, "max_turns": 1})
    await wait_status(client, workspace, run["id"])
    last = outputs_of(provider.requests[5])
    assert any("5 tool rounds left" in o for o in last) and any("1 tool round left" in o and "call `finish` now" in o for o in last)


def test_missed_edit_shows_where_the_text_probably_is() -> None:
    text = "\n".join(f"line {i}" for i in range(100)) + "\nfunction shoot(target) {\n  score += 10;\n}\n"
    old = "function shoot(target) {\n  score += 5;\n}"
    try:
        E.apply_edits(text, [E.A.Edit(old_string=old, new_string="x")])
    except ValueError as exc:
        msg = str(exc)
    assert "old_string not found" in msg and "score += 10;" in msg and "101  function shoot(target) {" in msg


def test_system_prompt_steers_toward_one_owner_and_sequencing() -> None:
    from app.kernel.runtime.context import AgentSpec

    a = AgentSpec.from_dict(agent("a", "Ann", entry=True), "generic")
    p = build_system_prompt(a, company="Co", goal="g", agents={"a": a}, edges=[])
    assert "ONE owner end-to-end" in p and "review / QA / testing starts once the thing exists" in p and "Bias to action" in p
