"""Debate termination (explicit consensus / decision / max rounds) and review loops."""
from __future__ import annotations

from app.llm.router import set_provider_override
from app.orchestrator.protocols import DebateState, ReviewState, debate_on_message, review_on_request, review_on_result
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, start_run, wait_status


def test_consensus_requires_both_agreements() -> None:
    st = DebateState("e", ["a", "b"], max_rounds=5)
    assert debate_on_message(st, "a", "proposal", "Plan X").accept
    assert debate_on_message(st, "b", "agreement", "ok").accept
    assert st.status == "open", "one-sided agreement is not consensus"
    debate_on_message(st, "a", "agreement", "ok")
    assert st.status == "consensus"


def test_objection_resets_agreement() -> None:
    st = DebateState("e", ["a", "b"], max_rounds=5)
    debate_on_message(st, "a", "proposal", "X")
    debate_on_message(st, "b", "agreement", "fine")
    debate_on_message(st, "a", "objection", "actually no")
    debate_on_message(st, "b", "agreement", "fine")
    assert st.status == "open"


def test_debate_max_rounds_closes() -> None:
    st = DebateState("e", ["a", "b"], max_rounds=2)
    for sender, t in [("a", "proposal"), ("b", "objection"), ("a", "proposal"), ("b", "objection")]:
        v = debate_on_message(st, sender, t, "...")
    assert st.status == "max_rounds" and v.event["result"] == "max_rounds"
    assert not debate_on_message(st, "a", "proposal", "again").accept


def test_debate_must_open_with_proposal() -> None:
    st = DebateState("e", ["a", "b"])
    assert not debate_on_message(st, "a", "objection", "?").accept


def test_review_loop_and_max_revisions() -> None:
    st = ReviewState("e", "dev", "rev", max_revisions=2)
    assert review_on_request(st).accept
    assert review_on_result(st, "request_changes", ["fix"]).accept and st.status == "changes_requested"
    review_on_request(st)
    v = review_on_result(st, "request_changes", ["still"])
    assert st.status == "max_revisions" and v.event["result"] == "max_revisions"
    st2 = ReviewState("e", "dev", "rev")
    review_on_request(st2)
    review_on_result(st2, "approve", [])
    assert st2.status == "approved"


async def test_debate_edge_multi_round_to_consensus(client, workspace) -> None:
    agents = [agent("p", "Pat", entry=True), agent("c", "Cam")]
    cid = await make_company(client, workspace, agents, [edge("d", "p", "c", "debate", True, max_rounds=5)])
    set_provider_override(ScriptedProvider({
        "Pat": [env(msg("Cam", "proposal", "Use Postgres")), env(msg("Cam", "proposal", "Use Postgres with read replicas")),
                env(msg("Cam", "agreement", "Agreed")), env({"action": "finish", "summary": "consensus"})],
        "Cam": [env(msg("Pat", "objection", "Single node is a SPOF")), env(msg("Pat", "agreement", "OK with replicas"))],
    }))
    run = await start_run(client, workspace, cid)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    proto = [e["payload"] for e in await events(client, workspace, run["id"], "protocol") if e["payload"]["kind"] == "debate"]
    assert proto and proto[-1]["result"] == "consensus"
    assert proto[-1]["state"]["rounds"] >= 2
    detail = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}")).json()
    assert any("Consensus" in d for d in detail["state"]["decisions"])


async def test_moderator_decision_ends_debate(client, workspace) -> None:
    agents = [agent("p", "Pat", entry=True), agent("c", "Cam"), agent("m", "Mo", role="Debate Moderator")]
    edges = [edge("d", "p", "c", "debate", True, max_rounds=5), edge("m1", "m", "p", "consult", True), edge("m2", "m", "c", "consult", True)]
    cid = await make_company(client, workspace, agents, edges)
    set_provider_override(ScriptedProvider({
        "Pat": [env(msg("Cam", "proposal", "A")), env(msg("Mo", "question", "please rule")), env({"action": "finish", "summary": "ruled"})],
        "Cam": [env(msg("Pat", "objection", "B instead"))],
        "Mo": [env(msg("Pat", "decision", "Ruling: A"), msg("Cam", "decision", "Ruling: A"))],
    }))
    run = await start_run(client, workspace, cid)
    await wait_status(client, workspace, run["id"])
    proto = [e["payload"] for e in await events(client, workspace, run["id"], "protocol") if e["payload"]["kind"] == "debate"]
    assert any(p["result"] == "decided" for p in proto)


async def test_review_edge_loops_until_approval(client, workspace) -> None:
    agents = [agent("dev", "Dee", entry=True), agent("rev", "Rey")]
    cid = await make_company(client, workspace, agents, [edge("r", "rev", "dev", "review", True, max_revisions=3)])
    set_provider_override(ScriptedProvider({
        "Dee": [env({"action": "write_file", "path": "app.py", "content": "print(1)\n"}, msg("Rey", "review_request", "v1 please")),
                env({"action": "write_file", "path": "app.py", "content": "print(2)\n"}, msg("Rey", "review_request", "v2")),
                env({"action": "finish", "summary": "approved"})],
        "Rey": [env(msg("Dee", "review_result", "needs work", verdict="request_changes", comments=["use 2"])),
                env(msg("Dee", "review_result", "LGTM", verdict="approve"))],
    }))
    run = await start_run(client, workspace, cid)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed"
    results = [e["payload"]["result"] for e in await events(client, workspace, run["id"], "protocol") if e["payload"]["kind"] == "review"]
    assert results == ["requested", "changes_requested", "requested", "approved"]
    arts = (await client.get(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/artifacts?all_versions=true")).json()
    assert [a["version"] for a in arts if a["path"] == "app.py"] == [1, 2]
