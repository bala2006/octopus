"""A long tool loop doesn't re-send every old file body and tool output on every round (latency + context leak)."""
from __future__ import annotations

import json
from pathlib import Path

from app.llm.router import set_provider_override
from app.orchestrator.engine import KEEP_FULL_ROUNDS, OLD_ROUND_CHARS, compact_rounds
from conftest import NativeScriptedProvider, agent, make_company, start_run, wait_status

BIG = "x = 1\n" * 4000  # 24k characters


def _round(n: int, args: dict, output: str) -> list[dict]:
    return [{"type": "reasoning", "id": f"rs{n}", "encrypted_content": f"enc{n}"},
            {"type": "function_call", "call_id": f"c{n}", "name": "write_file", "arguments": json.dumps(args)},
            {"type": "function_call_output", "call_id": f"c{n}", "output": output}]


def test_old_rounds_are_shortened_recent_ones_kept_verbatim() -> None:
    items, rounds = [], []
    for n in range(KEEP_FULL_ROUNDS + 2):
        rounds.append(len(items))
        items = compact_rounds([*items, *_round(n, {"path": f"f{n}.py", "content": BIG}, BIG)], rounds)
    old, recent = items[: rounds[-KEEP_FULL_ROUNDS]], items[rounds[-KEEP_FULL_ROUNDS]:]
    assert [i.get("call_id") or i["id"] for i in items] == [x for n in range(KEEP_FULL_ROUNDS + 2) for x in (f"rs{n}", f"c{n}", f"c{n}")]
    assert all(i["encrypted_content"] for i in items if i["type"] == "reasoning"), "reasoning is replayed untouched"
    for i in old:
        if i["type"] == "function_call":
            args = json.loads(i["arguments"])  # still valid JSON
            assert args["path"].startswith("f") and len(args["content"]) < OLD_ROUND_CHARS + 200 and "shortened" in args["content"]
        if i["type"] == "function_call_output":
            assert len(i["output"]) < OLD_ROUND_CHARS + 200
    assert all(BIG in (i.get("output") or json.loads(i.get("arguments") or "{}").get("content", BIG)) for i in recent if i["type"] != "reasoning")
    again = compact_rounds(items, rounds)
    assert again == items, "shortening twice changes nothing"


async def test_engine_request_stays_bounded_over_a_long_turn(client, workspace) -> None:
    rounds = [[("write_file", {"path": f"f{n}.py", "content": BIG})] for n in range(8)] + [[("finish", {"summary": "ok"})]]
    provider = NativeScriptedProvider({"Ann": rounds})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    sizes = [sum(len(json.dumps(i)) for i in r.continuation) for r in provider.requests]
    assert len(sizes) == 9
    # without compaction the last request carried all 8 file bodies (~200k characters); now only the recent rounds' do
    assert sizes[-1] < (KEEP_FULL_ROUNDS + 1) * len(BIG) + 20_000, sizes
    assert (Path(workspace["path"]) / "f0.py").read_text() == BIG, "only what the model sees is shortened, never the files"


async def test_system_prompt_is_stable_across_turns_so_it_can_be_cached(client, workspace) -> None:
    """The live team status used to sit in the middle of the system prompt, so only ~a third of it was a reusable prefix."""
    provider = NativeScriptedProvider({  # Ann's two turns see Ben in different states
        "Ann": [[("send_message", {"to": "Ben", "type": "task", "content": "please write notes.md"}), ("wait", {})],
                [("finish", {"summary": "ok"})]],
        "Ben": [[("write_file", {"path": "notes.md", "content": "hi"}),
                 ("send_message", {"to": "Ann", "type": "status_update", "content": "notes.md done"})], [("finish", {"summary": "done"})]]})
    set_provider_override(provider)
    from conftest import edge

    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b", bidirectional=True)])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    ann = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann"]
    status = [r.messages[1]["content"].split("# Team status\n", 1)[1].split("\n", 1)[0] for r in ann]
    assert len(set(status)) >= 2, f"the team's status changed between Ann's turns: {status}"
    systems = {r.messages[0]["content"] for r in ann}
    assert len(systems) == 1, "same system prompt for every call of a turn and across turns"


def test_prompt_cache_key_is_sent_and_droppable() -> None:
    from app.llm.azure_v1 import _body, _rejected_param
    from app.llm.base import LLMRequest

    req = LLMRequest(provider="azure", model="gpt-6-luna", messages=[{"role": "user", "content": "hi"}], api_key="k",
                     base_url="https://x.openai.azure.com", metadata={"cache_key": "octopus-run-a"})
    body = _body(req, "responses", set())
    assert body["prompt_cache_key"] == "octopus-run-a"
    err = '{"error": {"message": "Unrecognized request argument supplied: prompt_cache_key", "param": "prompt_cache_key"}}'
    assert _rejected_param(400, err, body) == "prompt_cache_key"
    assert "prompt_cache_key" not in _body(req, "responses", {"prompt_cache_key"})
