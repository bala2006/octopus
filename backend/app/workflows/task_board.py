"""The task board: task state, the update_task_board action, and the task records it writes.

Moved from orchestrator/board.py and orchestrator/handlers/tasks.py in Phase 5. The board's nudging and blackboard
stay in the orchestrator because they drive run behavior.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.core.execution_contracts import ACTIVE_ATTEMPT
from app.db.base import new_id
from app.db.repositories import TaskRepository
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.orchestrator.handlers.shared import OPEN_TASK_STATES
from app.workflows.routing import find_channel

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


def open_tasks(rt: RunRuntime) -> list[dict[str, Any]]:
    return [t for t in rt.tasks.values() if t["status"] in OPEN_TASK_STATES]


def task_ready(rt: RunRuntime, task: dict[str, Any]) -> bool:
    from app.core.task_contracts import dependency_blockers
    return task["status"] != "blocked" and not dependency_blockers(task, rt.tasks)


def task_line(rt: RunRuntime, t: dict[str, Any]) -> str:
    return f"{t['key']} [{t['status']}] {t['title']} (assignee: {rt.names.get(t['assignee'] or '', 'unassigned')})"


def open_task_owners(rt: RunRuntime) -> list[str]:
    owners: list[str] = []
    for t in rt.open_tasks():
        a = t["assignee"]
        if a in rt.agents and rt.agents[a].active and a not in owners:
            owners.append(a)
    return owners


async def link_task(rt: RunRuntime, creator: str, assignee: str, task_key: str | None, content: str) -> str:
    from app.core.task_contracts import contract
    if task_key and task_key not in rt.tasks:
        raise ValueError("Unknown task; create its owned contract before delegating it")
    if task_key and task_key in rt.tasks:
        t = rt.tasks[task_key]
        if t["assignee"] and t["assignee"] != assignee:
            raise ValueError("Task belongs to another owner; the lead must reassign it explicitly")
        rt.child_task_contract(contract(t))
        if not t["assignee"]:
            t["assignee"] = assignee
            await rt.save_task(t)
        return task_key
    for t in rt.tasks.values():
        if t["assignee"] == assignee and t["status"] == "todo":
            rt.child_task_contract(contract(t))
            return t["key"]
    title = next((ln.strip("#*- ") for ln in content.splitlines() if ln.strip()), "Task")[:100]
    t = await rt.create_task(creator, {"title": title, "description": content[:1500], "assignee": assignee, "status": "todo",
                                         "acceptance_criteria": ""})
    return t["key"]


def child_task_contract(rt: RunRuntime, proposed=None):
    from app.core.task_contracts import TaskContract, contract, permits_path
    parent = ACTIVE_ATTEMPT.get()
    if not parent or not parent.assignment.task_id:
        return proposed or TaskContract()
    parent_contract = contract(rt.tasks[parent.assignment.task_id])
    proposed = proposed or parent_contract
    if any(not permits_path(parent_contract.write_paths, path) for path in proposed.write_paths) or proposed.max_turns > parent_contract.max_turns:
        raise ValueError("A subtask cannot widen its parent's write scope or budget")
    return proposed


async def create_task(rt: RunRuntime, creator: str | None, fields: dict[str, Any]) -> dict[str, Any]:
    from app.core.task_contracts import TaskContract, validate_task
    constraints = rt.child_task_contract(TaskContract.model_validate(fields["constraints_json"]) if fields.get("constraints_json") else None).model_copy(
        update={"workflow_hash": rt.execution.workflow_contract().content_hash})
    t = {"id": new_id(), "key": f"T-{rt.task_counter + 1}", "title": fields.get("title") or "Untitled task",
         "description": fields.get("description") or "", "assignee": fields.get("assignee"), "status": fields.get("status") or "todo",
         "acceptance_criteria": fields.get("acceptance_criteria") or "", "created_by": creator,
         "constraints_json": constraints.model_dump(mode="json")}
    validate_task(t, rt.tasks)
    rt.task_counter += 1
    rt.tasks[t["key"]] = t
    await rt.save_task(t, new=True)
    rt.log(creator, f"created {t['key']} \"{t['title'][:120]}\"" + (f" for {rt.names.get(t['assignee'], '?')}" if t["assignee"] else ""))
    return t


async def save_task(rt: RunRuntime, t: dict[str, Any], new: bool = False) -> None:
    async with rt.db() as db:
        repo = TaskRepository(db)
        if new:
            await repo.insert(rt.run_id, t)
        else:
            await repo.update(t)
        await db.commit()
    await rt.emit("task_updated", {"task": {**t, "assignee_agent_id": t["assignee"], "run_id": rt.run_id}})


async def act_update_task_board(rt: RunRuntime, agent: AgentSpec, a: A.UpdateTaskBoard) -> None:
    from app.core.task_contracts import validate_task
    cid = await rt._tool_event(agent, "update_task_board", {"count": len(a.tasks)})
    changed = []
    for item in a.tasks:
        ac = "\n".join(f"- {x}" for x in item.acceptance_criteria) if isinstance(item.acceptance_criteria, list) else item.acceptance_criteria
        assignee = None
        if item.assignee:
            assignee = rt.resolve_agent(item.assignee)
            if assignee is None:
                rt.notice(agent.id, f"Task assignee '{item.assignee}' is not on the team; left unassigned.")
            elif assignee != agent.id and agent.id != rt.lead_agent_id and not (
                rt.manages(agent.id, assignee) and find_channel(rt.edges, agent.id, assignee, "task")):
                rt.notice(agent.id, "You cannot assign work outside your managed delegation channels.")
                continue
        key = (item.key or "").upper()
        if key and key in rt.tasks:
            original = rt.tasks[key]
            t = dict(original)
            if agent.id != rt.lead_agent_id and t.get("assignee") != agent.id and not rt.manages(agent.id, t.get("assignee") or ""):
                rt.notice(agent.id, f"You cannot change {key}: it belongs to another agent.")
                continue
            before = (t["status"], t["assignee"])
            for f, v in (("title", item.title), ("description", item.description), ("status", item.status), ("acceptance_criteria", ac)):
                if v is not None:
                    t[f] = v
            if assignee:
                t["assignee"] = assignee
            if item.constraints:
                if agent.id != rt.lead_agent_id:
                    rt.notice(agent.id, "Only the accountable lead may change an existing task's scope, dependencies, criteria or budget.")
                    continue
                t["constraints_json"] = item.constraints.model_copy(update={"workflow_hash": rt.execution.workflow_contract().content_hash}).model_dump(mode="json")
            try:
                validate_task(t, rt.tasks, previous=original)
            except ValueError as exc:
                rt.notice(agent.id, f"Task rejected: {exc}")
                continue
            rt.tasks[key] = t
            if (t["status"], t["assignee"]) != before:
                rt.mark_progress()
            await rt.save_task(t)
            changed.append(f"{key} → {t['status']}")
        elif item.title:
            constraints = item.constraints
            try:
                t = await rt.create_task(agent.id, {"title": item.title, "description": item.description, "assignee": assignee,
                    "status": item.status, "acceptance_criteria": ac,
                    "constraints_json": constraints.model_dump(mode="json") if constraints else {}})
            except ValueError as exc:
                rt.notice(agent.id, f"Task rejected: {exc}")
                continue
            rt.mark_progress()
            changed.append(f"created {t['key']}")
        else:
            rt.notice(agent.id, f"Unknown task key '{item.key}'. Existing: {', '.join(rt.tasks) or 'none'}")
    moved = [c for c in changed if not c.startswith("created")]
    if moved:
        rt.log(agent.id, "task board: " + ", ".join(moved))
    await rt._tool_result(agent, cid, "update_task_board", True, ", ".join(changed))
