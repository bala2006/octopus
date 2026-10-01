"""Fixes for the "a multi-agent run does worse than one agent" failure mode: questions nobody can answer, silent tool-round exhaustion, blind edit retries, parallel work that depends on other work."""
from __future__ import annotations

from app.llm.base import LLMRequest
from app.llm.router import set_provider_override
from app.orchestrator import engine as E
from app.orchestrator.context import build_system_prompt
from conftest import NativeScriptedProvider, agent, edge, make_company, start_run, wait_status

TEAM = [agent("a", "Ann", entry=True), agent("b", "Ben"), agent("c", "Cy")]
EDGES = [edge("ab", "a", "b"), edge("bc", "b", "c", type_="consult", bidirectional=True), edge("ba", "b", "a", type_="report")]


def outputs_of(req: LLMRequest) -> list[str]:
    return [i["output"] for i in req.continuation if i.get("type") == "function_call_output"]


async def test_delegated_worker_cannot_ask_questions_or_send_status_it_would_never_get_answered(client, workspace) -> None:
    provider = NativeScriptedProvider({
        "Ann": [[("delegate", {"to": "Ben", "objective": "Build index.html"})], [("finish", {"summary": "ok"})]],
        "Ben": [[("send_message", {"to": "Cy", "type": "question", "content": "What are the specs?"}),
                 ("send_message", {"to": "Ann", "type": "status_update", "content": "starting"})],
                [("write_file", {"path": "index.html", "content": "<h1>game</h1>"})], [("finish", {"summary": "built"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, TEAM, EDGES)
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    ben = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ben"]
    outs = outputs_of(ben[1])
    assert "REJECTED" in outs[0] and "make a sensible assumption" in outs[0]
    assert "REJECTED" in outs[1] and "finish` summary goes straight back to Ann" in outs[1]
    assert not any(r.metadata["mock_context"]["agent"]["name"] == "Cy" for r in provider.requests), "Cy never got woken by a question"


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
    from app.orchestrator.context import AgentSpec

    a = AgentSpec.from_dict(agent("a", "Ann", entry=True), "generic")
    p = build_system_prompt(a, company="Co", goal="g", agents={"a": a}, edges=[])
    assert "ONE owner end-to-end" in p and "review / QA / testing starts once the thing exists" in p and "Bias to action" in p
