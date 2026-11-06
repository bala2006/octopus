"""Storage repositories: the functions that write project rows.

Callers get a repository for a session factory (``rt.db`` in the runtime) and never build SQL themselves. Other project
tables still use sessions directly in API, service and capability modules. docs/architecture/refactor-plan.md, section 9,
lists what remains.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import update

from app.db.base import utcnow
from app.models import Task


class TaskRepository:
    def __init__(self, session_factory: Any) -> None:
        self._sessions = session_factory

    async def insert(self, run_id: str, t: dict[str, Any]) -> None:
        async with self._sessions() as db:
            db.add(Task(id=t["id"], run_id=run_id, key=t["key"], title=t["title"], description=t["description"],
                        assignee_agent_id=t["assignee"], status=t["status"], acceptance_criteria=t["acceptance_criteria"],
                        created_by=t["created_by"], constraints_json=t.get("constraints_json", {})))
            await db.commit()

    async def update(self, t: dict[str, Any]) -> None:
        async with self._sessions() as db:
            await db.execute(update(Task).where(Task.id == t["id"]).values(
                title=t["title"], description=t["description"], assignee_agent_id=t["assignee"], status=t["status"],
                acceptance_criteria=t["acceptance_criteria"], constraints_json=t.get("constraints_json", {}), updated_at=utcnow()))
            await db.commit()
