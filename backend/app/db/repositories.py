"""Storage repositories: the queries and writes for the project and registry tables, in one place.

A repository is bound to a session that the caller owns. Its methods run statements on that session and do not commit.
The caller commits, so transaction boundaries are the same as before the repositories existed. Models stay in
app/models; this module only holds the statements that touch them.

Project repositories take a project session (``rt.db()``). Registry repositories take a registry session
(``get_registry_db()``). Repositories still to come are listed in docs/architecture/refactor-plan.md, section 9.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.models import (
    Agent, AgentMemory, Artifact, ChatSession, Company, Edge, McpServer, Message, ProviderKey, Run, RunEvent, Task,
    User, UserRole, UserSkill, Workspace,
)


# ---------------------------------------------------------------- project database

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

    async def delete_ids(self, ids: Iterable[str]) -> None:
        await self.db.execute(delete(Message).where(Message.id.in_(list(ids))))

    async def for_run(self, run_id: str) -> list[Message]:
        return list((await self.db.execute(
            select(Message).where(Message.run_id == run_id).order_by(Message.created_at))).scalars().all())

    async def chat_for_session(self, session_id: str, *, newest_first: bool = False, limit: int | None = None) -> list[Message]:
        """Chat messages of a session (no run). ``newest_first`` with ``limit`` gives the latest N."""
        stmt = select(Message).where(Message.session_id == session_id, Message.run_id.is_(None))
        stmt = stmt.order_by(Message.created_at.desc() if newest_first else Message.created_at)
        if limit is not None:
            stmt = stmt.limit(limit)
        return list((await self.db.execute(stmt)).scalars().all())


class RunEventRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, event: RunEvent) -> None:
        self.db.add(event)

    async def report_events(self, run_id: str, types: Iterable[str]) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.type.in_(list(types))).order_by(RunEvent.id))).scalars().all())


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

    async def for_run_by_path(self, run_id: str) -> list[Artifact]:
        return list((await self.db.execute(select(Artifact).where(Artifact.run_id == run_id)
                                           .order_by(Artifact.path, Artifact.version))).scalars().all())


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

    async def for_run_by_key(self, run_id: str) -> list[Task]:
        return list((await self.db.execute(select(Task).where(Task.run_id == run_id).order_by(Task.key))).scalars().all())


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
        return list((await self.db.execute(
            select(Agent.id).where(Agent.id.in_(list(ids)), Agent.company_id != company_id))).scalars().all())


class EdgeRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, edge: Edge) -> None:
        self.db.add(edge)

    async def foreign_ids(self, ids: Iterable[str], company_id: str) -> list[str]:
        return list((await self.db.execute(
            select(Edge.id).where(Edge.id.in_(list(ids)), Edge.company_id != company_id))).scalars().all())


class CompanyRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, company_id: str) -> Company | None:
        return await self.db.get(Company, company_id)


class ChatSessionRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, session_id: str) -> ChatSession | None:
        return await self.db.get(ChatSession, session_id)


class AgentMemoryRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, row: AgentMemory) -> None:
        self.db.add(row)

    async def for_agent(self, agent_id: str) -> list[AgentMemory]:
        return list((await self.db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id))).scalars().all())

    async def by_key(self, agent_id: str, key: str) -> AgentMemory | None:
        return (await self.db.execute(select(AgentMemory).where(
            AgentMemory.agent_id == agent_id, AgentMemory.key == key))).scalar_one_or_none()


# ---------------------------------------------------------------- registry database

class UserRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, user_id: str) -> User | None:
        return await self.rdb.get(User, user_id)

    async def by_email(self, email: str, *, required: bool = False) -> User | None:
        result = await self.rdb.execute(select(User).where(User.email == email))
        return result.scalar_one() if required else result.scalar_one_or_none()

    def add(self, user: User) -> None:
        self.rdb.add(user)


class WorkspaceRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, workspace_id: str) -> Workspace | None:
        return await self.rdb.get(Workspace, workspace_id)


class ProviderKeyRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, user_id: str, provider: str) -> ProviderKey | None:
        return (await self.rdb.execute(select(ProviderKey).where(
            ProviderKey.user_id == user_id, ProviderKey.provider == provider))).scalar_one_or_none()


class UserRoleRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def for_user(self, user_id: str) -> list[UserRole]:
        return list((await self.rdb.execute(select(UserRole).where(UserRole.user_id == user_id))).scalars().all())


class UserSkillRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def for_user(self, user_id: str) -> list[UserSkill]:
        return list((await self.rdb.execute(select(UserSkill).where(UserSkill.user_id == user_id))).scalars().all())


class McpServerRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def enabled_for_user(self, ids: Iterable[str], user_id: str) -> list[McpServer]:
        return list((await self.rdb.execute(select(McpServer).where(
            McpServer.id.in_(list(ids)), McpServer.user_id == user_id, McpServer.enabled.is_(True)))).scalars().all())
