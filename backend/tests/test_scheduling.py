"""The scheduler is task-aware: open tasks wake their owners, a stuck board never reports "completed" (issue #27)."""
from __future__ import annotations

from app.llm.router import set_provider_override
from app.orchestrator.engine import MAX_SELF_TURNS
from conftest import ScriptedProvider, agent, edge, env, events, make_company, msg, run_messages, start_run, wait_status

TEAM = [agent("ceo", "Cleo", entry=True, role="CEO"), agent("dev", "Dev", role="Engineer")]
EDGES = [edge("d", "ceo", "dev", "delegate"), edge("r", "dev", "ceo", "report")]


def board(*items: dict) -> dict:
    return {"action": "update_task_board", "tasks": list(items)}


async def tasks(client, ws, run_id):  # type: ignore[no-untyped-def]
    return (await client.get(f"/api/v1/w/{ws['id']}/runs/{run_id}/tasks")).json()


async def test_open_tasks_never_end_as_completed(client, workspace) -> None:
    """Regression: the run went 'quiescent' and reported completed while the board still had work in progress."""
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({"Cleo": [env(msg("Dev", "task", "Build index.html"))]}))  # Dev only ever waits
    run = await start_run(client, workspace, cid)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete", done["halt_reason"]
    assert "open task" in done["halt_reason"] and "T-1" in done["halt_reason"]
    nudges = [m for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "system"]
    assert len(nudges) == 1 and nudges[0]["to_agent_id"] == "dev", "the owner is woken exactly once before giving up"
    assert "T-1" in nudges[0]["content"]


async def test_nudge_lets_the_owner_finish_the_work(client, workspace) -> None:
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({
        "Cleo": [env(msg("Dev", "task", "Build index.html")), env({"action": "finish", "summary": "shipped"})],
        "Dev": [env({"action": "wait"}),  # forgets about the task …
                env({"action": "write_file", "path": "index.html", "content": "<html></html>"},  # … until the scheduler nudges it
                    board({"key": "T-1", "status": "done"}), msg("Cleo", "status_update", "index.html done"))],
    }))
    run = await start_run(client, workspace, cid, permission_level="danger")
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and done["halt_reason"] == "", done["halt_reason"]
    assert [t["status"] for t in await tasks(client, workspace, run["id"])] == ["done"]
    assert any(m["sender"] == "system" and m["to_agent_id"] == "dev" for m in await run_messages(client, workspace, run["id"]))


async def test_blocked_board_is_escalated_to_the_entry_agent(client, workspace) -> None:
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({"Cleo": [env(board({"title": "QA the game", "assignee": "Dev", "status": "blocked"},
                                                               {"title": "Polish", "assignee": "Dev", "status": "blocked"}))]}))
    run = await start_run(client, workspace, cid)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "incomplete"
    nudges = [m for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "system"]
    assert [n["to_agent_id"] for n in nudges] == ["ceo"], "a deadlocked board goes to the entry agent, not the blocked owner"
    assert "blocked" in nudges[0]["content"]
    warn = [e["payload"]["message"] for e in await events(client, workspace, run["id"], "error")]
    assert any("deadlock" in w.lower() for w in warn)


async def test_finish_with_open_tasks_is_flagged(client, workspace) -> None:
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({"Cleo": [env(board({"title": "Write main.js", "assignee": "Dev", "status": "in_progress"}),
                                                         {"action": "finish", "summary": "all done!"})]}))
    run = await start_run(client, workspace, cid)
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed" and done["summary"] == "all done!"
    assert done["halt_reason"].startswith("Finished with 1 open task") and "T-1 in_progress" in done["halt_reason"]


async def test_follow_up_wakes_every_open_task_owner(client, workspace) -> None:
    """Regression: a follow-up only reached the entry agent, so owners of open tasks were never woken."""
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({"Cleo": [env(msg("Dev", "task", "Build index.html"))]}))
    run = await start_run(client, workspace, cid)
    assert (await wait_status(client, workspace, run["id"]))["status"] == "incomplete"

    set_provider_override(ScriptedProvider({"Dev": [env(board({"key": "T-1", "status": "done"}), msg("Cleo", "status_update", "done"))],
                                            "Cleo": [env({"action": "finish", "summary": "finished after the follow-up"})]}))
    r = await client.post(f"/api/v1/w/{workspace['id']}/runs/{run['id']}/continue", json={"content": "finish your pending tasks"})
    assert r.status_code == 202, r.text
    done = await wait_status(client, workspace, run["id"])
    assert done["status"] == "completed", done["halt_reason"]
    followups = [m for m in await run_messages(client, workspace, run["id"]) if m["sender"] == "user" and (m["meta"] or {}).get("followup")]
    assert {m["to_agent_id"] for m in followups} == {"ceo", "dev"}
    dev_msg = next(m for m in followups if m["to_agent_id"] == "dev")
    assert "You still own these open tasks" in dev_msg["content"] and "T-1" in dev_msg["content"]


async def test_reading_without_producing_does_not_spin(client, workspace) -> None:
    """Regression: read_file/list_files results re-activated the agent forever (12 of the last 14 turns had an empty inbox)."""
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider(default=env({"action": "list_files"})))
    run = await start_run(client, workspace, cid, budget={"max_turns": 50})
    done = await wait_status(client, workspace, run["id"])
    assert done["turns"] == 1 + MAX_SELF_TURNS, "one turn for the goal, then at most MAX_SELF_TURNS on its own results"
    assert done["status"] == "completed"


async def test_productive_self_turns_are_not_capped(client, workspace) -> None:
    """Writing a file in many parts is real progress, so it may take more turns than MAX_SELF_TURNS."""
    n = MAX_SELF_TURNS + 3
    script = [env({"action": "write_file", "path": "big.js", "content": f"// part {i}\n", "mode": "append", "partial": i < n - 1})
              for i in range(n)]
    cid = await make_company(client, workspace, [agent("a", "Ann", entry=True)], [])
    set_provider_override(ScriptedProvider({"Ann": script}))
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"])
    from pathlib import Path

    assert (Path(workspace["path"]) / "big.js").read_text().count("// part") == n


async def test_runs_list_reports_what_each_run_produced(client, workspace) -> None:
    """The Runs page must be able to tell a delivered run from a no-op (issue #32)."""
    cid = await make_company(client, workspace, TEAM, EDGES)
    set_provider_override(ScriptedProvider({"Cleo": [env(msg("Dev", "task", "Build index.html"))]}))
    stuck = await start_run(client, workspace, cid)
    await wait_status(client, workspace, stuck["id"])
    set_provider_override(ScriptedProvider({"Cleo": [env({"action": "write_file", "path": "a.html", "content": "<p>a</p>"},
                                                         {"action": "write_file", "path": "b.css", "content": "p{}"},
                                                         board({"title": "Ship", "assignee": "Dev", "status": "done"}),
                                                         {"action": "finish", "summary": "shipped"})]}))
    shipped = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, shipped["id"])
    runs = {r["id"]: r for r in (await client.get(f"/api/v1/w/{workspace['id']}/runs", params={"company_id": cid})).json()}
    def outcome(rid: str, expected: dict) -> dict:  # the fields this test is about (the outcome also carries context metrics)
        return {k: runs[rid]["outcome"][k] for k in expected}

    exp = {"tasks_total": 1, "tasks_done": 0, "tasks_open": 1, "tasks_blocked": 0, "files": 0,
                                            "errors": 0, "final_report": False,
                                            "agent_turns": 3, "work_turns": 0, "first_deliverable_turn": None, "delegations": 0}
    assert outcome(stuck["id"], exp) == exp
    exp = {"tasks_total": 1, "tasks_done": 1, "tasks_open": 0, "tasks_blocked": 0, "files": 2,
                                              "errors": 0, "final_report": True,
                                              "agent_turns": 1, "work_turns": 1, "first_deliverable_turn": 1, "delegations": 0}
    assert outcome(shipped["id"], exp) == exp
    assert runs[shipped["id"]]["outcome"]["context_mode"] == "pointers"
