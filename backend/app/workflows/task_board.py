"""The task board, as data: which tasks are open, which are ready to start, and how they read to agents.

Moved from app/orchestrator/board.py in Phase 5. The board's nudging and blackboard stay in the orchestrator
because they drive run behavior. These helpers only read the run's tasks and agents.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.orchestrator.handlers.shared import OPEN_TASK_STATES

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
