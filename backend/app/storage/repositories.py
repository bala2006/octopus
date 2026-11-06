"""Storage repositories: the queries and statements for the project and registry tables, in one place.

Boundary (decided for this refactor):
- Queries and set-based statements (select, update and delete by condition, counts) live in repositories.
- ORM unit-of-work on objects a caller already loaded (add, delete, refresh, flush, commit) stays with the session
  owner. Some repositories also offer add() where the caller already uses one.

A repository is bound to a session that the caller owns. Its methods do not commit, so transaction boundaries are the
same as before the repositories existed. Project repositories take a project session (``rt.db()`` or a request
session); registry repositories take a registry session. Models stay in app/models.
"""
from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import case, delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.base import utcnow
from app.storage.models.runtime_records import Consultation, ExecutionEvidence, RunRequest, TaskAttempt
from app.storage.models.scoped_memory import MemoryGroup, MemoryGroupMember, MemoryHead, MemoryRecord
from app.storage.models import Agent, AgentMemory, Artifact, ChatSession, Company, Edge, McpServer, Message, PluginState, ProviderKey, Run, RunEvent, Task, User, UserRole, UserSkill, UserTemplate, Workspace


# ---------------------------------------------------------------- project database

class RunRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, run_id: str) -> Run | None:
        return await self.db.get(Run, run_id)

    async def touch(self, run_id: str) -> None:
        """Update the run row without changing it, to take its write lock in this transaction."""
        await self.db.execute(update(Run).where(Run.id == run_id).values(turns=Run.turns))

    async def update(self, run_id: str, *where: Any, **values: Any) -> None:
        await self.db.execute(update(Run).where(Run.id == run_id, *where).values(**values))

    async def recent(self, company_id: str | None = None, limit: int = 200) -> list[Run]:
        q = select(Run).order_by(Run.created_at.desc()).limit(limit)
        if company_id:
            q = q.where(Run.company_id == company_id)
        return list((await self.db.execute(q)).scalars().all())

    async def live_count(self, company_id: str) -> int:
        return (await self.db.execute(select(func.count()).select_from(Run).where(
            Run.company_id == company_id, Run.status.in_(["running", "queued"])))).scalar() or 0

    async def by_client_request(self, company_id: str, client_id: str) -> Run | None:
        return await self.db.scalar(select(Run).where(
            Run.company_id == company_id, func.json_extract(Run.state_json, "$.initial_client_id") == client_id))

    async def for_user_with_company(self, user_id: str) -> list[Run]:
        return list((await self.db.execute(select(Run).join(Company).where(Company.user_id == user_id))).scalars().all())


class CompanyRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, company_id: str) -> Company | None:
        return await self.db.get(Company, company_id)

    async def for_user(self, user_id: str) -> list[Company]:
        return list((await self.db.execute(select(Company).where(Company.user_id == user_id)
                                           .order_by(Company.updated_at.desc()))).scalars().all())

    async def bump_revision_lock(self, company_id: str) -> None:
        """Take the company row's write lock in this transaction (used before a deduplicated insert)."""
        await self.db.execute(update(Company).where(Company.id == company_id).values(revision=Company.revision))


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

    async def session_history(self, session_id: str, *, newest_first: bool = False, limit: int | None = None) -> list[Message]:
        stmt = select(Message).where(Message.session_id == session_id)
        stmt = stmt.order_by(Message.created_at.desc() if newest_first else Message.created_at)
        if limit is not None:
            stmt = stmt.limit(limit)
        return list((await self.db.execute(stmt)).scalars().all())

    async def final_report_run_ids(self, run_ids: Iterable[str]) -> list[str]:
        return list((await self.db.execute(select(Message.run_id).where(
            Message.run_id.in_(list(run_ids)), Message.type == "final_report").distinct())).scalars().all())


class RunEventRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, event: RunEvent) -> None:
        self.db.add(event)

    async def report_events(self, run_id: str, types: Iterable[str]) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.type.in_(list(types))).order_by(RunEvent.id))).scalars().all())

    async def after(self, run_id: str, after: int, limit: int) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.id > after).order_by(RunEvent.id).limit(limit))).scalars().all())

    async def between(self, run_id: str, after: int, upto: int) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.id > after, RunEvent.id <= upto).order_by(RunEvent.id))).scalars().all())

    async def replay_after(self, run_id: str, last_seq: int) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.id > last_seq).order_by(RunEvent.id))).scalars().all())

    async def error_counts(self, run_ids: Iterable[str], kinds: Iterable[str]) -> list[tuple[str, int]]:
        kind = func.json_extract(RunEvent.payload_json, "$.kind")
        return [(rid, n) for rid, n in (await self.db.execute(select(RunEvent.run_id, func.count()).where(
            RunEvent.run_id.in_(list(run_ids)), RunEvent.type == "error", kind.in_(list(kinds)))
            .group_by(RunEvent.run_id))).all()]

    async def for_user_types(self, user_id: str, types: Iterable[str]) -> list[RunEvent]:
        return list((await self.db.execute(select(RunEvent).join(Run).join(Company).where(
            Company.user_id == user_id, RunEvent.type.in_(list(types))).order_by(RunEvent.id))).scalars().all())


class ArtifactRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, artifact: Artifact) -> None:
        self.db.add(artifact)

    async def path_exists(self, path: str) -> bool:
        return (await self.db.execute(select(Artifact.id).where(Artifact.path == path).limit(1))).first() is not None

    async def generated_paths(self) -> set[str]:
        return set((await self.db.execute(select(Artifact.path).distinct())).scalars())

    async def for_run(self, run_id: str) -> list[Artifact]:
        return list((await self.db.execute(
            select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.version))).scalars().all())

    async def for_run_by_path(self, run_id: str) -> list[Artifact]:
        return list((await self.db.execute(select(Artifact).where(Artifact.run_id == run_id)
                                           .order_by(Artifact.path, Artifact.version))).scalars().all())

    async def versions_of(self, run_id: str, path: str) -> list[Artifact]:
        return list((await self.db.execute(select(Artifact).where(
            Artifact.run_id == run_id, Artifact.path == path).order_by(Artifact.version))).scalars().all())

    async def first_version(self, run_id: str, path: str) -> Artifact | None:
        return (await self.db.execute(select(Artifact).where(Artifact.run_id == run_id, Artifact.path == path)
                                      .order_by(Artifact.version).limit(1))).scalar_one_or_none()

    async def version(self, run_id: str, path: str, version: int | None) -> Artifact | None:
        """The given version of a path, or the latest one when ``version`` is falsy."""
        q = select(Artifact).where(Artifact.run_id == run_id, Artifact.path == path)
        q = q.where(Artifact.version == version) if version else q.order_by(Artifact.version.desc())
        return (await self.db.execute(q.limit(1))).scalar_one_or_none()

    async def distinct_paths_by_run(self, run_ids: Iterable[str]) -> list[tuple[str, int]]:
        return [(rid, n) for rid, n in (await self.db.execute(
            select(Artifact.run_id, func.count(func.distinct(Artifact.path))).where(Artifact.run_id.in_(list(run_ids)))
            .group_by(Artifact.run_id))).all()]


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

    async def status_counts(self, run_ids: Iterable[str]) -> list[tuple[str, str, int]]:
        return [(rid, status, n) for rid, status, n in (await self.db.execute(
            select(Task.run_id, Task.status, func.count()).where(Task.run_id.in_(list(run_ids)))
            .group_by(Task.run_id, Task.status))).all()]


class AgentRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, agent: Agent) -> None:
        self.db.add(agent)

    async def get(self, agent_id: str) -> Agent | None:
        return await self.db.get(Agent, agent_id)

    async def active_ids_in_company(self, company_id: str) -> list[str]:
        return list((await self.db.scalars(select(Agent.id).where(Agent.company_id == company_id, Agent.active.is_(True)))).all())

    async def ids_in_company(self, company_id: str) -> set[str]:
        return set((await self.db.execute(select(Agent.id).where(Agent.company_id == company_id))).scalars())

    async def for_company(self, company_id: str) -> list[Agent]:
        return list((await self.db.execute(select(Agent).where(Agent.company_id == company_id))).scalars().all())

    async def foreign_ids(self, ids: Iterable[str], company_id: str) -> list[str]:
        """The ids among ``ids`` that belong to another company."""
        return list((await self.db.execute(
            select(Agent.id).where(Agent.id.in_(list(ids)), Agent.company_id != company_id))).scalars().all())


class EdgeRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, edge: Edge) -> None:
        self.db.add(edge)

    async def get(self, edge_id: str) -> Edge | None:
        return await self.db.get(Edge, edge_id)

    async def foreign_ids(self, ids: Iterable[str], company_id: str) -> list[str]:
        return list((await self.db.execute(
            select(Edge.id).where(Edge.id.in_(list(ids)), Edge.company_id != company_id))).scalars().all())


class ChatSessionRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def get(self, session_id: str) -> ChatSession | None:
        return await self.db.get(ChatSession, session_id)

    async def for_company(self, company_id: str) -> list[ChatSession]:
        return list((await self.db.execute(select(ChatSession).where(ChatSession.company_id == company_id)
                                           .order_by(ChatSession.created_at.desc()))).scalars().all())


class AgentMemoryRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    def add(self, row: AgentMemory) -> None:
        self.db.add(row)

    async def for_agent(self, agent_id: str) -> list[AgentMemory]:
        return list((await self.db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id))).scalars().all())

    async def notes_for_company(self, company_id: str) -> list[AgentMemory]:
        return list((await self.db.execute(select(AgentMemory).join(Agent, AgentMemory.agent_id == Agent.id)
                                           .where(Agent.company_id == company_id))).scalars().all())

    async def by_key(self, agent_id: str, key: str) -> AgentMemory | None:
        return (await self.db.execute(select(AgentMemory).where(
            AgentMemory.agent_id == agent_id, AgentMemory.key == key))).scalar_one_or_none()


class MemoryRepository:
    """Scoped memory: groups and their members, heads (one per scope and key) and their versioned records."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def group(self, group_id: str) -> MemoryGroup | None:
        return await self.db.get(MemoryGroup, group_id)

    async def groups_for_company(self, company_id: str) -> list[MemoryGroup]:
        return list((await self.db.scalars(select(MemoryGroup).where(MemoryGroup.company_id == company_id))).all())

    async def group_member_ids(self, group_id: str) -> list[str]:
        return list((await self.db.scalars(
            select(MemoryGroupMember.agent_id).where(MemoryGroupMember.group_id == group_id))).all())

    async def replace_group_members(self, group_id: str, agent_ids: Iterable[str]) -> None:
        await self.db.execute(delete(MemoryGroupMember).where(MemoryGroupMember.group_id == group_id))
        self.db.add_all(MemoryGroupMember(group_id=group_id, agent_id=aid) for aid in set(agent_ids))

    async def record(self, record_id: str) -> MemoryRecord | None:
        return await self.db.get(MemoryRecord, record_id)

    async def head(self, head_id: str) -> MemoryHead | None:
        return await self.db.get(MemoryHead, head_id)

    async def record_by_import_key(self, import_key: str) -> MemoryRecord | None:
        return await self.db.scalar(select(MemoryRecord).where(MemoryRecord.import_key == import_key))

    async def import_key_exists(self, import_key: str) -> bool:
        return await self.db.scalar(select(MemoryRecord.id).where(MemoryRecord.import_key == import_key)) is not None

    async def head_by_identity(self, company_id: str, scope: str, scope_id: str, key: str) -> MemoryHead | None:
        return await self.db.scalar(select(MemoryHead).where(
            MemoryHead.company_id == company_id, MemoryHead.scope == scope, MemoryHead.scope_id == scope_id, MemoryHead.key == key))

    async def current_record(self, head_id: str, version: int) -> MemoryRecord | None:
        return await self.db.scalar(select(MemoryRecord).where(MemoryRecord.head_id == head_id, MemoryRecord.version == version))

    async def bump_head_version(self, head_id: str, expected_version: int) -> int:
        """Compare-and-set the head's version. Returns the number of rows changed (1 when the version matched)."""
        result = await self.db.execute(update(MemoryHead).where(
            MemoryHead.id == head_id, MemoryHead.version == expected_version).values(version=expected_version + 1))
        return result.rowcount

    async def records_for_head(self, company_id: str, scope: str, scope_id: str, key: str) -> list[MemoryRecord]:
        return list((await self.db.scalars(select(MemoryRecord).join(MemoryHead, MemoryRecord.head_id == MemoryHead.id).where(
            MemoryHead.company_id == company_id, MemoryHead.scope == scope, MemoryHead.scope_id == scope_id,
            MemoryHead.key == key, MemoryRecord.classification != "deleted").order_by(MemoryRecord.version))).all())

    async def records_with_heads(self, company_id: str) -> list[Any]:
        return list((await self.db.execute(select(MemoryRecord, MemoryHead).join(
            MemoryHead, MemoryRecord.head_id == MemoryHead.id).where(
            MemoryHead.company_id == company_id, MemoryRecord.version == MemoryHead.version)
            .order_by(MemoryRecord.pinned.desc(), MemoryRecord.created_at.desc()))).all())

    async def agent_records(self, company_id: str, agent_id: str, key: str | None = None) -> list[Any]:
        query = select(MemoryRecord, MemoryHead.key).join(MemoryHead, MemoryRecord.head_id == MemoryHead.id).where(
            MemoryHead.company_id == company_id, MemoryHead.scope == "agent", MemoryHead.scope_id == agent_id,
            MemoryRecord.version == MemoryHead.version)
        if key is not None:
            query = query.where(MemoryHead.key == key)
        return list((await self.db.execute(query.order_by(MemoryHead.key))).all())

    async def source(self, kind: str, source_id: str) -> Any:
        """A message or artifact that memory can cite as its source."""
        return await self.db.get(Message if kind == "message" else Artifact, source_id)


# ---------------------------------------------------------------- run runtime tables (requests, attempts, consultations)

class RunRequestRepository:
    """Queued and applied user requests of one run. transition() is a compare-and-set on the current state."""

    def __init__(self, db: AsyncSession, run_id: str) -> None:
        self.db, self.run_id = db, run_id

    async def list_for_run(self) -> list[RunRequest]:
        return list((await self.db.execute(select(RunRequest).where(RunRequest.run_id == self.run_id)
                                           .order_by(RunRequest.created_at, RunRequest.id))).scalars().all())

    async def get(self, request_id: str) -> RunRequest | None:
        return await self.db.scalar(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id == request_id))

    async def by_client_id(self, client_id: str) -> RunRequest | None:
        return (await self.db.execute(select(RunRequest).where(
            RunRequest.run_id == self.run_id, RunRequest.client_id == client_id))).scalar_one_or_none()

    async def first_queued(self) -> RunRequest | None:
        """The next queued request: steers first, then by creation order."""
        return (await self.db.execute(select(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.state == "queued")
                                      .order_by(case((RunRequest.kind == "steer", 0), else_=1), RunRequest.created_at,
                                                RunRequest.id).limit(1))).scalar_one_or_none()

    async def transition(self, request_id: str, from_state: str, *extra: Any, **values: Any) -> Any:
        """Set ``values`` only if the request is still in ``from_state`` (and ``extra`` holds). Returns the result: check rowcount."""
        return await self.db.execute(update(RunRequest).where(
            RunRequest.id == request_id, RunRequest.run_id == self.run_id, RunRequest.state == from_state, *extra).values(**values))

    async def supersede_queued(self, revision: int) -> None:
        await self.db.execute(update(RunRequest).where(
            RunRequest.run_id == self.run_id, RunRequest.state == "queued").values(revision=revision))

    async def cancel_in_states(self, states: Any) -> None:
        await self.db.execute(update(RunRequest).where(
            RunRequest.run_id == self.run_id, RunRequest.state.in_(states)).values(state="cancelled"))

    async def mark_recovery(self, request_ids: Any, from_state: str) -> None:
        await self.db.execute(update(RunRequest).where(RunRequest.run_id == self.run_id, RunRequest.id.in_(request_ids),
                                                       RunRequest.state == from_state).values(state="recovery_required"))

    async def claimed_to_recovery(self) -> Any:
        return await self.db.execute(update(RunRequest).where(
            RunRequest.run_id == self.run_id, RunRequest.state == "claimed").values(state="recovery_required"))


class TaskAttemptRepository:
    def __init__(self, db: AsyncSession, run_id: str) -> None:
        self.db, self.run_id = db, run_id

    async def get(self, attempt_id: str) -> TaskAttempt | None:
        return await self.db.get(TaskAttempt, attempt_id)

    async def active_id(self, agent_id: str, states: Any) -> str | None:
        return await self.db.scalar(select(TaskAttempt.id).where(
            TaskAttempt.run_id == self.run_id, TaskAttempt.agent_id == agent_id, TaskAttempt.state.in_(states)))

    async def find(self, *where: Any) -> list[TaskAttempt]:
        return list((await self.db.scalars(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id, *where))).all())

    async def ordered(self) -> list[TaskAttempt]:
        return list((await self.db.execute(select(TaskAttempt).where(TaskAttempt.run_id == self.run_id)
                                           .order_by(TaskAttempt.started_at))).scalars().all())

    async def finish(self, attempt_id: str, revision: int, state: str, result: dict) -> Any:
        """Record a result only if the attempt is still running at this revision. Returns the result: check rowcount."""
        return await self.db.execute(update(TaskAttempt).where(
            TaskAttempt.id == attempt_id, TaskAttempt.run_id == self.run_id, TaskAttempt.revision == revision,
            TaskAttempt.state == "running").values(state=state, result_json=result, ended_at=utcnow()))

    async def mark_running_recovery(self) -> Any:
        return await self.db.execute(update(TaskAttempt).where(
            TaskAttempt.run_id == self.run_id, TaskAttempt.state == "running").values(state="recovery_required", ended_at=utcnow()))


class ConsultationRepository:
    def __init__(self, db: AsyncSession, run_id: str) -> None:
        self.db, self.run_id = db, run_id

    async def find(self, *where: Any) -> list[Consultation]:
        return list((await self.db.scalars(select(Consultation).where(Consultation.run_id == self.run_id, *where))).all())


class EvidenceRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def for_run(self, run_id: str) -> list[ExecutionEvidence]:
        return list((await self.db.execute(select(ExecutionEvidence).where(ExecutionEvidence.run_id == run_id))).scalars().all())


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

    async def for_user(self, user_id: str) -> list[Workspace]:
        return list((await self.rdb.execute(select(Workspace).where(Workspace.user_id == user_id)
                                            .order_by(Workspace.last_opened_at.desc()))).scalars().all())

    async def by_path(self, user_id: str, path: str) -> Workspace | None:
        return (await self.rdb.execute(select(Workspace).where(
            Workspace.user_id == user_id, Workspace.path == path))).scalar_one_or_none()


class PluginStateRepository:
    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    async def all(self) -> dict[str, PluginState]:
        return {row.id: row for row in (await self.db.execute(select(PluginState))).scalars().all()}

    async def set(self, plugin_id: str, *, enabled: bool, version: str) -> None:
        row = await self.db.get(PluginState, plugin_id)
        if row is None:
            self.db.add(PluginState(id=plugin_id, enabled=enabled, version=version))
        else:
            row.enabled, row.version = enabled, version


class ProviderKeyRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, user_id: str, provider: str) -> ProviderKey | None:
        return (await self.rdb.execute(select(ProviderKey).where(
            ProviderKey.user_id == user_id, ProviderKey.provider == provider))).scalar_one_or_none()

    async def for_user(self, user_id: str, providers: Iterable[str] | None = None) -> list[ProviderKey]:
        q = select(ProviderKey).where(ProviderKey.user_id == user_id)
        if providers is not None:
            q = q.where(ProviderKey.provider.in_(list(providers)))
        return list((await self.rdb.execute(q)).scalars().all())


class UserRoleRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def for_user(self, user_id: str) -> list[UserRole]:
        return list((await self.rdb.execute(select(UserRole).where(UserRole.user_id == user_id))).scalars().all())

    async def by_key(self, user_id: str, key: str) -> UserRole | None:
        return (await self.rdb.execute(select(UserRole).where(
            UserRole.user_id == user_id, UserRole.key == key))).scalar_one_or_none()


class UserSkillRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def for_user(self, user_id: str) -> list[UserSkill]:
        return list((await self.rdb.execute(select(UserSkill).where(UserSkill.user_id == user_id))).scalars().all())

    async def by_name(self, user_id: str, name: str) -> UserSkill | None:
        return (await self.rdb.execute(select(UserSkill).where(
            UserSkill.user_id == user_id, UserSkill.name == name))).scalar_one_or_none()


class UserTemplateRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, key: str) -> UserTemplate | None:
        return await self.rdb.get(UserTemplate, key)

    async def for_user(self, user_id: str) -> list[UserTemplate]:
        return list((await self.rdb.execute(select(UserTemplate).where(UserTemplate.user_id == user_id)
                                            .order_by(UserTemplate.updated_at.desc()))).scalars().all())


class McpServerRepository:
    def __init__(self, rdb: AsyncSession) -> None:
        self.rdb = rdb

    async def get(self, server_id: str) -> McpServer | None:
        return await self.rdb.get(McpServer, server_id)

    async def enabled_for_user(self, ids: Iterable[str], user_id: str) -> list[McpServer]:
        return list((await self.rdb.execute(select(McpServer).where(
            McpServer.id.in_(list(ids)), McpServer.user_id == user_id, McpServer.enabled.is_(True)))).scalars().all())

    async def for_user(self, user_id: str) -> list[McpServer]:
        return list((await self.rdb.execute(select(McpServer).where(McpServer.user_id == user_id)
                                            .order_by(McpServer.name))).scalars().all())

    async def by_name(self, user_id: str, name: str) -> McpServer | None:
        return (await self.rdb.execute(select(McpServer).where(
            McpServer.user_id == user_id, McpServer.name == name))).scalar_one_or_none()
