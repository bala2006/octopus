"""Task constraints are enforced by the real scheduler and shared tool executor."""
from pathlib import Path
from contextlib import contextmanager

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.plugins.providers.router import set_provider_override
from app.storage.models import Agent, Task
from app.storage.models.runtime_records import TaskAttempt
from app.sdk import actions as A
from app.sdk.agents import AgentSpec
from app.sdk.contracts import Assignment, ExecutionPolicy
from app.sdk.execution_contracts import ACTIVE_ATTEMPT, AttemptContext
from app.sdk.task_contracts import TaskContract, validate_task
from conftest import NativeScriptedProvider, agent, edge, events, make_company, start_run, wait_status
from test_runtime_recovery_regressions import inspection_runtime  # noqa: F401 (a pytest fixture is imported by name)


def test_graph_and_terminal_transitions_reject_invalid_state():
    first = {"key": "T-1", "status": "todo", "constraints_json": {"dependencies": ["T-2"]}}
    second = {"key": "T-2", "status": "todo", "constraints_json": {"dependencies": ["T-1"]}}
    with pytest.raises(ValueError, match="cycle"):
        validate_task(first, {"T-2": second})
    with pytest.raises(ValueError, match="Unknown dependency"):
        validate_task(first, {})
    with pytest.raises(ValueError, match="transition"):
        validate_task({"key": "T-1", "status": "in_progress"}, {}, previous={"status": "done"})
    with pytest.raises(ValueError, match="Write scopes"):
        TaskContract(write_paths=("../outside",))


async def test_dependency_scheduler_waits_for_producer_and_persists_contract(client, workspace):
    provider = NativeScriptedProvider({
        "Lead": [[("update_task_board", {"tasks": [
            {"title": "Produce contract", "assignee": "Builder"},
            {"title": "Review contract", "assignee": "Reviewer", "constraints": {"dependencies": ["T-1"], "max_turns": 2}},
        ]})], [("send_message", {"to": "Reviewer", "type": "task", "task_id": "T-2", "content": "Review after producer"}),
                  ("send_message", {"to": "Builder", "type": "task", "task_id": "T-1", "content": "Produce the contract"})],
                 [("wait", {})], [("finish", {"summary": "Both owned tasks accepted"})]],
        "Builder": [[("finish", {"summary": "Produced contract"})]],
        "Reviewer": [[("finish", {"summary": "Reviewed completed contract"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("builder", "Builder"), agent("reviewer", "Reviewer")],
                             [edge("lb", "lead", "builder"), edge("lr", "lead", "reviewer")])
    run = await start_run(client, workspace, cid, permission_level="danger")
    final = await wait_status(client, workspace, run["id"], timeout=15)
    order = [r.metadata["turn_context"]["agent"]["name"] for r in provider.requests]
    assert order.index("Builder") < order.index("Reviewer")
    base = f"/api/v1/w/{workspace['id']}/runs/{run['id']}"
    tasks = (await client.get(base + "/tasks")).json()
    assert [t["status"] for t in tasks] == ["done", "done"]
    assert tasks[1]["constraints_json"]["dependencies"] == ["T-1"]
    attempts = (await client.get(base + "/execution")).json()["attempts"]
    review = next(a for a in attempts if a["assignment"]["owner"] == "reviewer")
    assert review["assignment"]["dependencies"] == ["T-1"]
    assert review["assignment"]["max_turns"] == 2
    assert final["status"] == "completed"


async def test_task_scope_blocks_outside_files_and_arbitrary_shell(client, workspace):
    provider = NativeScriptedProvider({
        "Lead": [[("update_task_board", {"tasks": [{"title": "Scoped edit", "assignee": "Worker", "constraints": {"write_paths": ["src"]}}]})],
                 [("delegate", {"to": "Worker", "objective": "Edit src/ok.txt", "task_id": "T-1"})],
                 [("finish", {"summary": "Accepted scoped output"})]],
        "Worker": [[("write_file", {"path": "outside.txt", "content": "denied"}),
                    ("run_code", {"command": "python -c 'print(1)'"}),
                    ("write_file", {"path": "src/ok.txt", "content": "allowed"})],
                   [("finish", {"summary": "Scoped output ready"})]],
    })
    set_provider_override(provider)
    cid = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("worker", "Worker")], [edge("lw", "lead", "worker")])
    run = await start_run(client, workspace, cid, permission_level="danger")
    await wait_status(client, workspace, run["id"], timeout=15)
    assert not (Path(workspace["path"]) / "outside.txt").exists()
    assert (Path(workspace["path"]) / "src/ok.txt").read_text() == "allowed"
    calls = await events(client, workspace, run["id"], "tool_call")
    assert not any(e["payload"]["tool"] == "run_code" for e in calls)
    failures = await events(client, workspace, run["id"], "error")
    assert sum(e["payload"].get("message") == "Task write scope denied action" for e in failures) == 2


@pytest_asyncio.fixture
async def scoped_manager(inspection_runtime):  # noqa: F811
    runtime = inspection_runtime
    child = AgentSpec.from_dict(agent("child", "Child", reports_to="reviewer"), "generic")
    runtime.agents["child"] = child
    runtime.names["child"] = "Child"
    runtime.status["child"] = "idle"
    runtime.agents["reviewer"].is_manager = True
    async with runtime.db() as db, db.begin():
        db.add(Agent(id="child", company_id="co", name="Child"))
    parent = await runtime.create_task("lead", {"title": "Scoped parent", "assignee": "reviewer",
               "constraints_json": {"write_paths": ["src"], "max_turns": 2}})
    return runtime, parent


@contextmanager
def parent_attempt(runtime, parent):
    contract = TaskContract.model_validate(parent["constraints_json"])
    assignment = Assignment(run_id="run", owner="reviewer", lead="lead", task_id=parent["key"], provider="azure",
                            model="gpt-6-luna", original_goal=runtime.goal, write_paths=contract.write_paths,
                            max_turns=contract.max_turns, policy=ExecutionPolicy())
    token = ACTIVE_ATTEMPT.set(AttemptContext("parent-attempt", assignment))
    try:
        yield
    finally:
        ACTIVE_ATTEMPT.reset(token)


async def test_delegated_child_inherits_scope_and_budget_through_real_assignment(scoped_manager, monkeypatch):
    runtime, parent = scoped_manager
    with parent_attempt(runtime, parent):
        key = await runtime.link_task("reviewer", "child", None, "Implement the scoped child")
    child_task = runtime.tasks[key]
    assert child_task["constraints_json"]["write_paths"] == ["src"]
    assert child_task["constraints_json"]["max_turns"] == 2
    async with runtime.db() as db:
        saved = await db.get(Task, child_task["id"])
        assert saved.constraints_json == child_task["constraints_json"]
    invocations = []
    async def turn(aid):
        invocations.append(ACTIVE_ATTEMPT.get().assignment)
        await runtime.execute(runtime.agents[aid], A.WriteFile(action="write_file", path="outside.txt", content="Denied"))
        await runtime.execute(runtime.agents[aid], A.WriteFile(action="write_file", path="src/child.txt", content="Allowed"))
    monkeypatch.setattr(runtime, "_turn", turn)
    await runtime.execution.owned_turn("child")
    assert invocations[0].task_id == key
    assert invocations[0].write_paths == ("src",)
    assert invocations[0].max_turns == 2
    assert not (runtime.root / "outside.txt").exists()
    assert (runtime.root / "src/child.txt").read_text() == "Allowed"


async def test_scoped_manager_cannot_reuse_existing_unrestricted_child_task(scoped_manager):
    runtime, parent = scoped_manager
    unrestricted = await runtime.create_task("lead", {"title": "Unrestricted existing task", "assignee": "child"})
    for explicit_key in (None, unrestricted["key"]):
        with parent_attempt(runtime, parent), pytest.raises(ValueError, match="cannot widen"):
            await runtime.link_task("reviewer", "child", explicit_key, "Attempt scope bypass")
    assert runtime.tasks[unrestricted["key"]]["constraints_json"]["write_paths"] == ["*"]
    assert len(runtime.tasks) == 2
    assert runtime.mailbox.get("child", []) == []


async def test_delegation_rejects_task_owned_by_a_different_target(scoped_manager):
    runtime, parent = scoped_manager
    with parent_attempt(runtime, parent), pytest.raises(ValueError, match="another owner"):
        await runtime.link_task("reviewer", "child", parent["key"], "Redirect an existing owner's task")
    assert runtime.tasks[parent["key"]]["assignee"] == "reviewer"


async def test_exhausted_task_budget_blocks_before_another_worker_invocation(scoped_manager, monkeypatch):
    runtime, parent = scoped_manager
    parent["constraints_json"]["max_turns"] = 1
    await runtime.save_task(parent)
    invocations = []
    async def turn(aid):
        invocations.append(aid)
    monkeypatch.setattr(runtime, "_turn", turn)
    await runtime.execution.owned_turn("reviewer")
    await runtime.execution.owned_turn("reviewer")
    assert invocations == ["reviewer"]
    assert runtime.tasks[parent["key"]]["status"] == "blocked"
    assert runtime.task_turns[parent["key"]] == 1
    async with runtime.db() as db:
        assert (await db.get(Task, parent["id"])).status == "blocked"
        attempts = (await db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == "run"))).all()
        assert len(attempts) == 1
