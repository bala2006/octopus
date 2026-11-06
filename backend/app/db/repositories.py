"""Storage repositories: the queries and writes for the project tables, in one place.

A repository is bound to a session that the caller owns. Its methods run statements on that session and do not commit.
The caller commits, so transaction boundaries are the same as before the repositories existed. Models stay in
app/models; this module only holds the statements that touch them.

Repositories still to come are listed in docs/architecture/refactor-plan.md, section 9.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.models import Agent, Artifact, Company, Edge, McpServer, Message, Run, RunEvent, Task


class RunRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, run_id: str) -> Run | None:
        return await self.db.get(Run, run_id)

    async def update(self, run_id: str, *where: Any, **values: Any) -> None:
        await self.db.execute(update(Run).where(Run.id == run_id, *where).values(**values))


class MessageRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, message: Message) -> None:
        self.db.add(message)

    async def set_read(self, ids: Iterable[str], read: bool) -> None:
        await self.db.execute(update(Message).where(Message.id.in_(list(ids))).values(read=read))

    async def for_run(self, run_id: str) -> list[Message]:
        return list((await self.db.execute(
            select(Message).where(Message.run_id == run_id).order_by(Message.created_at))).scalars().all())


class RunEventRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, event: RunEvent) -> None:
        self.db.add(event)


class ArtifactRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, artifact: Artifact) -> None:
        self.db.add(artifact)

    async def path_exists(self, path: str) -> bool:
        return (await self.db.execute(select(Artifact.id).where(Artifact.path == path).limit(1))).first() is not None

    async def for_run(self, run_id: str) -> list[Artifact]:
        return list((await self.db.execute(
            select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.version))).scalars().all())


class TaskRepository:
    """Task rows. insert() and update() take the task record used by the task board (dict form)."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def insert(self, run_id: str, t: dict[str, Any]) -> None:
        self.db.add(Task(id=t["id"], run_id=run_id, key=t["key"], title=t["title"], description=t["description"],
                         assignee_agent_id=t["assignee"], status=t["status"], acceptance_criteria=t["acceptance_criteria"],
                         created_by=t["created_by"], constraints_json=t.get("constraints_json", {})))

    async def update(self, t: dict[str, Any]) -> None:
        await self.db.execute(update(Task).where(Task.id == t["id"]).values(
            title=t["title"], description=t["description"], assignee_agent_id=t["assignee"], status=t["status"],
            acceptance_criteria=t["acceptance_criteria"], constraints_json=t.get("constraints_json", {}), updated_at=utcnow()))

    async def for_run(self, run_id: str) -> list[Task]:
        return list((await self.db.execute(select(Task).where(Task.run_id == run_id))).scalars().all())


class AgentRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, agent: Agent) -> None:
        self.db.add(agent)

    async def get(self, agent_id: str) -> Agent | None:
        return await self.db.get(Agent, agent_id)

    async def ids_in_company(self, company_id: str) -> set[str]:
        return set((await self.db.execute(select(Agent.id).where(Agent.company_id == company_id))).scalars())

    async def foreign_ids(self, ids: Iterable[str], company_id: str) -> list[str]:
        """The ids among ``ids`` that belong to another company."""
        return list((await self.db.execute(select(Agent.id).where(Agent.id.in_(list(ids)), Agent.company_id != company_id))).scalars().all())


class EdgeRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, edge: Edge) -> None:
        self.db.add(edge)

    async def foreign_ids(self, ids: Iterable[str], company_id: str) -> list[str]:
        return list((await self.db.execute(select(Edge.id).where(Edge.id.in_(list(ids)), Edge.company_id != company_id))).scalars().all())


class CompanyRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, company_id: str) -> Company | None:
        return await self.db.get(Company, company_id)


class McpServerRepository:
    """The registry database holds MCP servers, so this repository is bound to a registry session."""

    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def enabled_for_user(self, ids: Iterable[str], user_id: str) -> list[McpServer]:
        return list((await self.rdb.execute(select(McpServer).where(
            McpServer.id.in_(list(ids)), McpServer.user_id == user_id, McpServer.enabled.is_(True)))).scalars().all())
