"""Agents may only talk over connected edges (direction + type aware), enforced server-side."""
from __future__ import annotations

from app.llm.router import set_provider_override
from app.orchestrator.permissions import EdgeSpec, allowed_recipients, find_channel, rejection_reason
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status


def test_find_channel_direction_and_types() -> None:
    edges = [EdgeSpec("e1", "a", "b", "delegate"), EdgeSpec("e2", "a", "b", "debate", bidirectional=True),
             EdgeSpec("e3", "b", "c", "review", bidirectional=True)]
    assert find_channel(edges, "a", "b", "task").id == "e1"
    assert find_channel(edges, "a", "b", "proposal").id == "e2"
    assert find_channel(edges, "b", "a", "objection").id == "e2"  # bidirectional debate
    assert find_channel(edges, "b", "a", "task") is None  # delegate is one-way, debate edges only carry debate types
    assert find_channel(edges, "c", "b", "review_request").id == "e3"
    assert find_channel(edges, "a", "c", "task") is None  # not connected
    assert find_channel(edges, "a", "a", "task") is None  # no self messages
    assert set(allowed_recipients(edges, "b")) == {"a", "c"}
    assert "one-way" in rejection_reason([EdgeSpec("x", "b", "a")], "a", "b", "task", {"a": "A", "b": "B"})


async def test_unconnected_message_is_rejected(client, workspace) -> None:
    agents = [agent("a1", "Alice", entry=True), agent("b1", "Bob"), agent("c1", "Carol")]
    edges = [edge("e1", "a1", "b1")]
    cid = await make_company(client, workspace, agents, edges)
    set_provider_override(ScriptedProvider({
        "Alice": [env(msg("Carol", "task", "sneaky direct task"), msg("Bob", "task", "legit task")),
                  env({"action": "finish", "summary": "done"})],
        "Bob": [env({"action": "wait"})],
    }))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    msgs = await run_messages(client, workspace, run["id"])
    agent_msgs = [(m["from_agent_id"], m["to_agent_id"]) for m in msgs if m["sender"] == "agent" and m["to_agent_id"]]
    assert ("a1", "b1") in agent_msgs
    assert ("a1", "c1") not in agent_msgs, "message over a non-existent edge must never be delivered"
    rej = await events(client, workspace, run["id"], "message_rejected")
    assert any(e["payload"]["to_agent_id"] == "c1" and "no communication channel" in e["payload"]["reason"] for e in rej)


async def test_reverse_of_directional_edge_is_rejected(client, workspace) -> None:
    agents = [agent("a1", "Alice", entry=True), agent("b1", "Bob")]
    cid = await make_company(client, workspace, agents, [edge("e1", "a1", "b1")])
    set_provider_override(ScriptedProvider({
        "Alice": [env(msg("Bob", "task", "please do X")), env({"action": "finish", "summary": "ok"})],
        "Bob": [env(msg("Alice", "status_update", "done X"))],
    }))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    msgs = await run_messages(client, workspace, run["id"])
    assert not any(m["from_agent_id"] == "b1" and m["to_agent_id"] == "a1" for m in msgs)
    rej = await events(client, workspace, run["id"], "message_rejected")
    assert any("one-way" in e["payload"]["reason"] for e in rej)


async def test_broadcast_only_reaches_connected(client, workspace) -> None:
    agents = [agent("a1", "Alice", entry=True), agent("b1", "Bob"), agent("c1", "Carol"), agent("d1", "Dan")]
    edges = [edge("e1", "a1", "b1"), edge("e2", "a1", "c1", "consult", bidirectional=True)]
    cid = await make_company(client, workspace, agents, edges)
    set_provider_override(ScriptedProvider({"Alice": [env(msg("all", "question", "status?")), env({"action": "finish", "summary": "x"})]}))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    to = {m["to_agent_id"] for m in await run_messages(client, workspace, run["id"]) if m["from_agent_id"] == "a1" and m["type"] == "question"}
    assert to == {"b1", "c1"}


async def test_canvas_rejects_self_loops_and_duplicates(client, workspace) -> None:
    base = f"/api/v1/w/{workspace['id']}"
    cid = (await client.post(f"{base}/companies", json={"name": "X"})).json()["company"]["id"]
    agents = [agent("a1", "A"), agent("b1", "B")]
    r = await client.put(f"{base}/companies/{cid}/canvas", json={"agents": agents, "edges": [edge("e1", "a1", "a1")]})
    assert r.status_code == 422
    r = await client.put(f"{base}/companies/{cid}/canvas", json={"agents": agents, "edges": [edge("e1", "a1", "b1"), edge("e2", "a1", "b1")]})
    assert r.status_code == 422
    r = await client.put(f"{base}/companies/{cid}/canvas", json={"agents": agents, "edges": [edge("e1", "a1", "b1"), edge("e2", "a1", "b1", "review")]})
    assert r.status_code == 200
