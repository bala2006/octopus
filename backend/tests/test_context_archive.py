"""Near-lossless context: older items become pointers into the run's archive, recall / search_history bring back the exact
original, the team ledger is edited item by item, and the prompt is ordered stable → changing for the prompt cache."""
from __future__ import annotations

import json

import httpx

from app.llm.azure_v1 import BREAKPOINT, AzureV1Provider, _body, _dropped, _rejected_param
from app.llm.base import LLMRequest
from app.llm.router import set_provider_override
from app.orchestrator.context import pointer_lines, window_cut
from conftest import NativeScriptedProvider, ScriptedProvider, agent, edge, env, events, make_company, msg, start_run, wait_status

LONG = ("We agreed on PostgreSQL. The port is 5433, not 5432, because the CI box already runs one. "
        "Migrations live in db/migrations and must be reversible. ") * 3  # a first-sentence summary would keep only "We agreed on PostgreSQL."
BIG = "line = 'x' * 80\n" * 2000  # 32k characters


TOPICS = ["database schema", "login form", "payment webhook", "search index", "email queue", "dark mode", "rate limiter",
          "audit log", "file upload", "csv export"]


def distinct(i: int, who: str) -> str:  # different enough not to be blocked as a repeat by the loop detector
    return f"{who} on the {TOPICS[i]}: {' '.join(reversed(TOPICS[i].split()))} item {i * 7919 % 1000}"


def last_user(req: LLMRequest) -> str:
    return req.messages[-1]["content"]


def all_user(req: LLMRequest) -> str:
    return "\n".join(m["content"] for m in req.messages if m["role"] == "user")


# ---------------------------------------------------------------- pure helpers

def test_pointer_window_moves_in_blocks_so_the_prefix_is_stable() -> None:
    assert window_cut(10, 30) == 0
    assert [window_cut(n, 30) for n in (44, 45, 59, 60)] == [0, 15, 15, 30], "the cut jumps by 15, not by one message per turn"
    older = [{"ref": f"m{i}", "turn": i, "from": "b", "to": "a", "type": "answer", "content": f"line {i}\nmore", "sender": "agent"}
             for i in range(1, 451)]
    text = pointer_lines(older, {"b": "Ben"}, "a")
    assert text.splitlines()[0].startswith("- m1 … m100: 100 earlier messages"), "very old pointers collapse in whole blocks"
    assert "- m450 t450 Ben→you answer (13 chars): line 450" in text


def test_breakpoints_are_sent_and_dropped_when_the_deployment_rejects_them() -> None:
    req = LLMRequest(provider="azure", model="gpt-6-luna", api_key="k", base_url="https://x.openai.azure.com",
                     messages=[{"role": "system", "content": "rules", "cache_breakpoint": True},
                               {"role": "user", "content": "conversation", "cache_breakpoint": True},
                               {"role": "user", "content": "new messages"}])
    body = _body(req, "responses", set())
    assert body["input"][0] == {"role": "system", "content": [{"type": "input_text", "text": "rules", BREAKPOINT: {"mode": "explicit"}}]}
    assert body["input"][2] == {"role": "user", "content": "new messages"}, "the changing part has no breakpoint"
    assert _body(req, "chat", set())["messages"][1]["content"][0]["type"] == "text"
    err = json.dumps({"error": {"message": "Unknown parameter: 'input[0].content[0].prompt_cache_breakpoint'.",
                                "param": "input[0].content[0].prompt_cache_breakpoint"}})
    assert _rejected_param(400, err, body) == BREAKPOINT
    plain = _body(req, "responses", {BREAKPOINT})
    assert [m["content"] for m in plain["input"]] == ["rules", "conversation", "new messages"]
    assert _rejected_param(400, err, plain) is None, "no endless retry once breakpoints are off"


async def test_deployment_without_breakpoints_is_retried_plain_and_remembered() -> None:
    sent: list[dict] = []

    def handler(r: httpx.Request) -> httpx.Response:
        body = json.loads(r.content)
        sent.append(body)
        if BREAKPOINT in json.dumps(body["input"]):
            return httpx.Response(400, json={"error": {"message": "Unrecognized request argument supplied: prompt_cache_breakpoint"}})
        ok = "".join(f"data: {json.dumps(e)}\n\n" for e in [{"type": "response.output_text.delta", "item_id": "m", "delta": "ok"},
                                                            {"type": "response.completed", "response": {"usage": {}}}])
        return httpx.Response(200, content=ok.encode(), headers={"content-type": "text/event-stream"})

    _dropped.clear()
    req = LLMRequest(provider="azure", model="gpt-6-luna", api_key="k", base_url="https://bp.openai.azure.com",
                     messages=[{"role": "system", "content": "rules", "cache_breakpoint": True}, {"role": "user", "content": "hi"}])
    p = AzureV1Provider(httpx.MockTransport(handler))
    assert "".join([c.delta async for c in p.stream(req)]) == "ok"
    assert "".join([c.delta async for c in p.stream(req)]) == "ok"
    assert len(sent) == 3, "rejected once, then plain messages for this deployment from then on"


# ---------------------------------------------------------------- engine

async def test_older_messages_become_pointers_and_recall_gives_the_exact_text(client, workspace) -> None:
    """Regression for the lossy first-sentence summary: details past the first sentence of an old message were gone."""
    seen: list[str] = []

    def ann(ctx, outputs):  # noqa: ANN001
        if not outputs:
            return [("recall", {"ref": "m3"})]  # m1 goal, m2 Ann's first question, m3 Ben's long answer
        seen.extend(outputs)
        return [("finish", {"summary": "ok"})]

    asks = [[("send_message", {"to": "Ben", "type": "question", "content": distinct(i, "question") + "?"}), ("wait", {})] for i in range(8)]
    answers = [[("send_message", {"to": "Ann", "type": "answer", "content": LONG if i == 0 else distinct(i, "update")}),
                ("wait", {})] for i in range(8)]
    native = NativeScriptedProvider({"Ann": [*asks, ann, ann], "Ben": answers})
    set_provider_override(native)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b", "consult", True)])
    run = await start_run(client, workspace, cid, budget={"context_recent": 4, "max_turns": 60})
    await wait_status(client, workspace, run["id"])

    last = [r for r in native.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann"][-2]  # before the recall result
    stable = last.messages[1]["content"]
    assert "# Earlier conversation" in stable and "Summary of earlier conversation" not in all_user(last)
    assert "- m2 " in stable and "Ben→you answer" in stable, "an old message is a one-line pointer with its reference"
    assert LONG not in all_user(last), "the full old text is not repeated in the prompt"
    assert seen and LONG in seen[0], "recall returns the original, every sentence of it"
    assert last.messages[0].get("cache_breakpoint") and last.messages[1].get("cache_breakpoint")
    assert "# NEW messages for you" in last_user(last) and "# Blackboard" in last_user(last), "changing parts come last"


async def test_stable_part_is_identical_between_turns_while_the_window_holds(client, workspace) -> None:
    rounds = [[("send_message", {"to": "Ben", "type": "status_update", "content": distinct(i, "note")}), ("wait", {})] for i in range(6)]
    native = NativeScriptedProvider({"Ann": rounds, "Ben": [[("send_message", {"to": "Ann", "type": "answer", "content": distinct(i, "ack")}),
                                                              ("wait", {})] for i in range(6)]})
    set_provider_override(native)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b", "consult", True)])
    run = await start_run(client, workspace, cid, budget={"context_recent": 30, "max_turns": 20})
    await wait_status(client, workspace, run["id"])
    ann = [r for r in native.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann" and len(r.messages) == 3]
    assert len(ann) >= 3
    for prev, nxt in zip(ann, ann[1:]):
        assert nxt.messages[1]["content"].startswith(prev.messages[1]["content"]), "the conversation part only grows at its end"


async def test_long_tool_rounds_become_pointers_with_exact_recall(client, workspace) -> None:
    got: dict[str, str] = {}

    def final(ctx, outputs):  # noqa: ANN001
        if "a1" not in got:
            got["a1"] = "pending"
            return [("recall", {"ref": "a1"}), ("recall", {"ref": "f0.py@v1"}), ("recall", {"ref": "o1"})]
        got["args"], got["file"], got["out"] = outputs[-3:]
        return [("finish", {"summary": "ok"})]

    rounds = [[("write_file", {"path": f"f{n}.py", "content": BIG})] for n in range(6)] + [[("read_file", {"path": "f0.py"})]]
    provider = NativeScriptedProvider({"Ann": [*rounds, final, final]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    cont = provider.requests[-1].continuation
    calls = [i for i in cont if i.get("type") == "function_call"]
    first_args = json.loads(calls[0]["arguments"])
    assert first_args["path"] == "f0.py" and "kept as a1" in first_args["content"], "old arguments: pointer, JSON still valid"
    assert BIG not in first_args["content"], "the file body is not re-sent in old rounds"
    mid = [i for i in provider.requests[4].continuation if i.get("type") == "function_call"]  # after 4 rounds
    assert "kept as" in mid[0]["arguments"] and all(json.loads(c["arguments"])["content"] == BIG for c in mid[1:]), "the last 3 rounds are verbatim"
    assert json.loads(got["args"].split("\n", 1)[1].rsplit("\n…[", 1)[0])["content"].startswith(BIG[:1000])
    assert BIG[:5000] in got["file"] and "f0.py@v1" in got["file"], "file versions are recallable by path@version"
    assert "o1 · turn 1 · Ann · output of read_file" in got["out"] and BIG[:3000] in got["out"], "short outputs need no pointer; o1 is the read"
    sizes = [sum(len(json.dumps(i)) for i in r.continuation) for r in provider.requests]
    # after six 32k writes: three are pointers, three verbatim (without pointers it would be all six)
    assert 3 * len(BIG) < sizes[6] < 4 * len(BIG) + 20_000, sizes


async def test_search_history_finds_teammates_messages_and_outputs(client, workspace) -> None:
    found: list[str] = []
    asked: list[bool] = []

    def ann(ctx, outputs):  # noqa: ANN001
        if not asked:
            asked.append(True)
            return [("search_history", {"query": '"port is 5433"'}), ("search_history", {"query": "reversible migrations"}),
                    ("search_history", {"query": "zebra"})]
        found.extend(outputs[-3:])
        return [("finish", {"summary": "ok"})]

    provider = NativeScriptedProvider({"Ben": [[("send_message", {"to": "Cat", "type": "answer", "content": LONG})],
                                               [("finish", {"summary": "told Cat"})]],
                                       "Ann": [[("delegate", {"to": "Ben", "objective": "tell Cat about the DB"})], ann, ann]})
    set_provider_override(provider)
    agents = [agent("a", "Ann", entry=True), agent("b", "Ben"), agent("c", "Cat")]
    cid = await make_company(client, workspace, agents, [edge("e1", "a", "b"), edge("e2", "b", "c", "consult", True)])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    phrase, words, none = found
    assert "Ben→Cat answer" in phrase and "port is 5433" in phrase, "Ann finds a conversation between two teammates"
    assert "reversible" in words.lower() and "No matches for 'zebra'" in none


async def test_ledger_is_edited_item_by_item_and_keeps_history(client, workspace) -> None:
    def ann1(ctx, outputs):  # noqa: ANN001
        return [("update_ledger", {"items": [{"kind": "decision", "text": "Use SQLite"}, {"kind": "question", "text": "Auth needed?"}]}),
                ("send_message", {"to": "Ben", "type": "task", "content": "build it"}), ("wait", {})]

    def ben(ctx, outputs):  # noqa: ANN001
        if not outputs:
            return [("update_ledger", {"items": [{"id": "L1", "text": "Use PostgreSQL", "note": "SQLite can't do concurrent writes"},
                                                 {"id": "L2", "status": "resolved", "note": "No, single user"},
                                                 {"id": "L9", "text": "nope"}]}),
                    ("recall", {"ref": "L1"})]
        return [("send_message", {"to": "Ann", "type": "status_update", "content": "updated the ledger"}), ("finish", {"summary": "done"})]

    provider = NativeScriptedProvider({"Ann": [ann1, [("finish", {"summary": "ok"})]], "Ben": [ben, ben]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b", "consult", True)])
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    ann_last = [r for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ann"][-1]
    text = last_user(ann_last)
    assert "- L1 [decision] Use PostgreSQL (note: SQLite can't do concurrent writes)" in text, "Ann sees Ben's edit"
    assert "- L2 [question, resolved] Auth needed? → No, single user" in text
    assert "ledger changed L1" in text, "the change shows up in Ann's team activity"
    ben_out = [o for r in provider.requests if r.metadata["mock_context"]["agent"]["name"] == "Ben"
               for o in (i.get("output") for i in r.continuation if i.get("type") == "function_call_output") if o]
    assert any("Not applied: L9: no such ledger item" in o for o in ben_out)
    assert any("Use PostgreSQL" in o and "earlier" in o and "Use SQLite" in o for o in ben_out), "recall shows the item's history"
    upd = [e["payload"] for e in await events(client, workspace, run["id"], "ledger_updated")]
    assert len(upd) == 2 and {i["id"] for i in upd[1]["items"]} == {"L1", "L2"}


async def test_summary_mode_keeps_the_previous_approach_for_comparison(client, workspace) -> None:
    provider = NativeScriptedProvider({"Ann": [[("finish", {"summary": "ok"})]]})
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    run = await start_run(client, workspace, cid, budget={"context_mode": "summary"})
    await wait_status(client, workspace, run["id"])
    req = provider.requests[0]
    assert len(req.messages) == 2 and not req.messages[0].get("cache_breakpoint")
    assert not {"recall", "search_history", "update_ledger"} & {t["name"] for t in req.tools}
    runs = (await client.get(f"/api/v1/w/{workspace['id']}/runs", params={"company_id": cid})).json()
    assert runs[0]["outcome"]["context_mode"] == "summary"


async def test_messages_get_stable_references_and_a_broadcast_shares_one(client, workspace) -> None:
    set_provider_override(ScriptedProvider({"Ann": [env(msg("Ben", "task", "do it"), {"action": "wait"})]}))
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True), agent("b", "Ben")], [edge("e", "a", "b")])
    run = await start_run(client, workspace, cid, mode="step")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    await wait_status(client, workspace, run["id"], {"paused"})
    await client.post(f"{base}/interject", json={"content": "hello team"})
    msgs = (await client.get(f"{base}/messages")).json()
    refs = [m["meta"]["ref"] for m in msgs]
    assert refs == ["m1", "m2"], "goal, then one reference for the message to everyone"
    from app.models import Message
    from sqlalchemy import select
    from app.orchestrator.engine import manager

    rt = manager.get(run["id"])
    async with rt.db() as db:
        copies = (await db.execute(select(Message).where(Message.run_id == run["id"], Message.type == "user_interjection"))).scalars().all()
    assert len(copies) == 2 and {c.meta_json["ref"] for c in copies} == {"m2"}
    await client.post(f"{base}/control/stop")
