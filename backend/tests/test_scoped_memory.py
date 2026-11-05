from __future__ import annotations

import json
import asyncio

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.db.base import ProjectBase
from app.db.session import make_engine
from app.models import Agent, AgentMemory, Company, Message, Run
from app.models.scoped_memory import MemoryHead, MemoryRecord
from app.services.scoped_memory import (
    Actor, MemoryConflict, MemoryDenied, SourceRef, Target, context, get, import_legacy, owner_group, owner_put, put,
)


@pytest_asyncio.fixture
async def memory(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'memory.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(ProjectBase.metadata.create_all)
    sf = async_sessionmaker(engine, expire_on_commit=False)
    async with sf() as db, db.begin():
        db.add_all([Company(id="company", user_id="owner", name="Mine"), Company(id="other", user_id="other-owner", name="Other")])
        await db.flush()
        db.add_all([Agent(id=aid, company_id="company", name=aid) for aid in ("a", "b", "c")])
        db.add(Agent(id="foreign", company_id="other", name="Foreign"))
        db.add_all([Run(id="run", company_id="company", goal="Goal", snapshot_json={"agents": [{"id": aid} for aid in ("a", "b")]}), Run(id="other-run", company_id="other", goal="Private")])
    yield sf, Actor("owner", "company"), tmp_path
    await engine.dispose()


@pytest.mark.asyncio
async def test_private_and_group_reads_use_database_membership(memory):
    sf, owner, _ = memory
    a, b, c = (Actor("owner", "company", aid) for aid in ("a", "b", "c"))
    private = await put(sf, a, Target("agent", "a"), "note", "Private finding", expected_version=0)
    with pytest.raises(MemoryDenied):
        await get(sf, b, private.id)
    group = await owner_group(sf, owner, "API collaborators", ["a", "b"])
    shared = await put(sf, a, Target("group", group), "contract", "Version 2", expected_version=0)
    assert (await get(sf, b, shared.id)).content == "Version 2"
    with pytest.raises(MemoryDenied):
        await get(sf, c, shared.id)
    with pytest.raises(MemoryDenied):
        await owner_group(sf, a, "Self escalation", ["a", "c"])
    with pytest.raises(MemoryDenied):
        await owner_group(sf, owner, "Cross-company", ["foreign"])


@pytest.mark.asyncio
async def test_ownership_run_binding_and_identity_are_checked(memory):
    sf, owner, _ = memory
    record = await owner_put(sf, owner, Target("project", "company"), "fact", "Mine", expected_version=0)
    for actor in (Actor("other-owner", "company"), Actor("owner", "company", "foreign")):
        with pytest.raises(MemoryDenied):
            await get(sf, actor, record.id)
    with pytest.raises(MemoryDenied):
        await put(sf, Actor("owner", "company", "a"), Target("chat", "other-run"), "x", "y", expected_version=0)
    with pytest.raises(MemoryDenied):
        await owner_put(sf, owner, Target("project", "company", "other-run"), "x", "y", expected_version=0)


@pytest.mark.asyncio
async def test_versions_are_append_only_and_stale_updates_conflict(memory):
    sf, owner, _ = memory
    target = Target("project", "company")
    original = await owner_put(sf, owner, target, "constraint", "Desktop only", expected_version=0, pinned=True)
    latest = await owner_put(sf, owner, target, "constraint", "Desktop and CLI", expected_version=1, pinned=True)
    assert latest.version == 2
    assert (await get(sf, owner, original.id)).content == "Desktop only"
    with pytest.raises(MemoryConflict):
        await owner_put(sf, owner, target, "constraint", "Stale edit", expected_version=1)
    with pytest.raises(MemoryDenied):
        await put(sf, Actor("owner", "company", "a"), target, "constraint", "Override", expected_version=2)
    assert [(m.content, m.pinned) for m in await context(sf, owner)] == [("Desktop and CLI", True)]


@pytest.mark.asyncio
async def test_agent_cannot_promote_or_leak_private_sources(memory):
    sf, owner, _ = memory
    a = Actor("owner", "company", "a")
    original = await put(sf, a, Target("agent", "a"), "private", "Private detail", expected_version=0)
    with pytest.raises(MemoryDenied):
        await put(sf, a, Target("project", "company"), "leak", "Copied detail", expected_version=0,
                  refs=(SourceRef("memory", original.id),))
    with pytest.raises(MemoryDenied):
        await owner_put(sf, a, Target("agent", "a"), "private", "Accepted", expected_version=1)
    approved = await owner_put(sf, owner, Target("project", "company"), "public fact", "Approved disclosure", expected_version=0,
                               refs=(SourceRef("memory", original.id),), share_sources=True)
    assert (await get(sf, Actor("owner", "company", "b"), approved.id)).content == "Approved disclosure"


@pytest.mark.asyncio
async def test_summaries_keep_exact_sources_and_pinned_constraints(memory):
    sf, owner, _ = memory
    async with sf() as db, db.begin():
        message = Message(id="m1", run_id="run", sender="user", content="Full original requirements. Keep every detail.")
        db.add(message)
    constraint = await owner_put(sf, owner, Target("chat", "run"), "constraint", "Desktop only", expected_version=0, pinned=True,
                                 refs=(SourceRef("message", "m1"),))
    summary = await owner_put(sf, owner, Target("chat", "run"), "summary", "Short recap", expected_version=0,
                              refs=(SourceRef("message", "m1"), SourceRef("memory", constraint.id)))
    result = await context(sf, Actor("owner", "company", "a"), run_id="run")
    assert result[0].id == constraint.id
    assert (await get(sf, owner, summary.id)).source_refs == (SourceRef("message", "m1"), SourceRef("memory", constraint.id))
    async with sf() as db:
        assert (await db.get(Message, "m1")).content == "Full original requirements. Keep every detail."
    assert await context(sf, owner) == []
    with pytest.raises(MemoryDenied):
        await put(sf, Actor("owner", "company", "a"), Target("project", "company"), "summary leak", "Recap", expected_version=0,
                  refs=(SourceRef("message", "m1"),))


@pytest.mark.asyncio
async def test_context_excludes_proposals_tombstones_and_redacts_secrets(memory):
    sf, owner, _ = memory
    a = Actor("owner", "company", "a")
    await put(sf, a, Target("agent", "a"), "guess", "Maybe true", expected_version=0)
    first = await owner_put(sf, owner, Target("project", "company"), "credentials", "token=abc123 public text", expected_version=0)
    assert (await get(sf, a, first.id, redact=False)).content == "token=[REDACTED] public text"
    assert len(await context(sf, a)) == 1
    assert len(await context(sf, a, include_proposed=True)) == 2
    await owner_put(sf, owner, Target("project", "company"), "credentials", "", expected_version=1, classification="deleted")
    assert await context(sf, a) == []
    assert (await get(sf, owner, first.id)).content == "token=[REDACTED] public text"


@pytest.mark.asyncio
async def test_legacy_import_is_idempotent_and_preserves_source_notes(memory):
    sf, owner, root = memory
    async with sf() as db, db.begin():
        db.add(AgentMemory(id="legacy", agent_id="a", key="style", value="Use pytest"))
    (root / ".octopus").mkdir()
    path = root / ".octopus" / "memory.json"
    original = {"notes": {"stack": {"value": "Python"}}, "runs": [{"run_id": "run", "summary": "Old result"}, {"run_id": "other-run", "summary": "Foreign"}]}
    path.write_text(json.dumps(original), encoding="utf-8")
    assert await import_legacy(sf, owner, root) == 3
    assert await import_legacy(sf, owner, root) == 0
    assert json.loads(path.read_text()) == original
    async with sf() as db:
        assert len((await db.scalars(select(MemoryRecord))).all()) == 3
        assert (await db.get(AgentMemory, "legacy")).value == "Use pytest"
    assert await context(sf, owner, run_id="run") == []
    assert len(await context(sf, owner, run_id="run", include_proposed=True)) == 3


@pytest.mark.asyncio
async def test_concurrent_writers_cannot_overwrite_each_other(memory):
    sf, owner, _ = memory
    target = Target("project", "company")
    await owner_put(sf, owner, target, "shared", "Initial", expected_version=0)
    results = await asyncio.gather(
        owner_put(sf, owner, target, "shared", "One", expected_version=1),
        owner_put(sf, owner, target, "shared", "Two", expected_version=1), return_exceptions=True)
    assert sum(isinstance(result, MemoryConflict) for result in results) == 1
    current = await context(sf, owner)
    assert len(current) == 1 and current[0].version == 2
    async with sf() as db:
        assert len((await db.scalars(select(MemoryRecord))).all()) == 2


@pytest.mark.asyncio
async def test_context_budget_preserves_exact_original_reference(memory):
    sf, owner, _ = memory
    original = await owner_put(sf, owner, Target("project", "company"), "large", "Requirement. " * 1000,
                               expected_version=0, pinned=True)
    result = await context(sf, owner, max_chars=300)
    assert len(result[0].content) <= 300
    assert f"retrieve memory:{original.id}" in result[0].content
    assert (await get(sf, owner, original.id)).content == "Requirement. " * 1000


@pytest_asyncio.fixture
async def memory_client(memory):
    from types import SimpleNamespace
    import httpx
    from fastapi import FastAPI
    from app.api.v1.memory import router
    from app.channels.deps import current_user, get_pdb, project_ctx
    from app.models import User

    sf, _, _ = memory
    application = FastAPI()
    application.include_router(router, prefix="/api/v1/w/{workspace_id}")
    async def pdb():
        async with sf() as db:
            yield db
    application.dependency_overrides[get_pdb] = pdb
    application.dependency_overrides[current_user] = lambda: User(id="owner", email="owner@example.test", password_hash="unused")
    application.dependency_overrides[project_ctx] = lambda: SimpleNamespace(sf=sf)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_owner_api_versions_conflicts_redaction_and_foreign_company(memory_client):
    url = "/api/v1/w/workspace/memory?company_id=company"
    body = {"scope": "project", "scope_id": "company", "key": "rule", "content": "secret=hidden Desktop only",
            "expected_version": 0, "classification": "verified", "pinned": True}
    response = await memory_client.put(url, json=body)
    assert response.status_code == 200, response.text
    original = response.json()
    assert original["content"] == "secret=[REDACTED] Desktop only"
    assert (await memory_client.put(url, json=body)).status_code == 409
    body.update(expected_version=1, content="Desktop and CLI")
    assert (await memory_client.put(url, json=body)).json()["version"] == 2
    versions = await memory_client.get("/api/v1/w/workspace/memory/versions", params={"company_id": "company", "scope": "project", "scope_id": "company", "key": "rule"})
    assert [record["version"] for record in versions.json()] == [1, 2]
    assert (await memory_client.get(f"/api/v1/w/workspace/memory/{original['id']}?company_id=company")).json()["version"] == 1
    assert (await memory_client.get("/api/v1/w/workspace/memory?company_id=other")).status_code == 404
    body["agent_id"] = "foreign"
    assert (await memory_client.put(url, json=body)).status_code == 422


@pytest.mark.asyncio
async def test_owner_api_group_membership_and_archive_revoke_reads(memory, memory_client):
    sf, _, _ = memory
    url = "/api/v1/w/workspace/memory/groups"
    created = await memory_client.post(url + "?company_id=company", json={"name": "Shared", "members": ["a", "b"]})
    assert created.status_code == 201, created.text
    gid = created.json()["id"]
    row = await put(sf, Actor("owner", "company", "a"), Target("group", gid), "note", "Shared", expected_version=0)
    assert (await get(sf, Actor("owner", "company", "b"), row.id)).content == "Shared"
    changed = await memory_client.patch(f"{url}/{gid}?company_id=company", json={"name": "A only", "members": ["a"]})
    assert changed.status_code == 204
    with pytest.raises(MemoryDenied):
        await get(sf, Actor("owner", "company", "b"), row.id)
    groups = (await memory_client.get(url + "?company_id=company")).json()
    assert groups == [{"id": gid, "name": "A only", "members": ["a"], "active": True}]
    assert (await memory_client.delete(f"{url}/{gid}?company_id=company")).status_code == 204
    with pytest.raises(MemoryDenied):
        await get(sf, Actor("owner", "company", "a"), row.id)
    assert (await get(sf, Actor("owner", "company"), row.id)).content == "Shared"
    assert (await memory_client.post(url + "?company_id=company", json={"name": "Foreign", "members": ["foreign"]})).status_code == 404


def test_group_archive_migration_repairs_old_schema_and_is_idempotent(tmp_path):
    import importlib.util
    from pathlib import Path
    import sqlalchemy as sa
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    path = Path(__file__).parents[1] / "migrations/project/versions/0006_memory_group_active.py"
    spec = importlib.util.spec_from_file_location("group_archive_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'legacy.db'}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text("CREATE TABLE memory_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL)"))
            connection.execute(sa.text("INSERT INTO memory_groups VALUES ('old', 'Existing group')"))
            with Operations.context(MigrationContext.configure(connection)):
                module.upgrade()
                module.upgrade()
            assert connection.execute(sa.text("SELECT active FROM memory_groups WHERE id='old'")).scalar() == 1
    finally:
        engine.dispose()


async def test_search_checks_acl_before_returning_matching_memory(memory):
    sf, owner, _ = memory
    await owner_put(sf, owner, Target("agent", "a"), "secret-design", "Hidden needle", expected_version=0)
    shared = await owner_put(sf, owner, Target("project", "company"), "design", "Shared needle", expected_version=0)
    records = await context(sf, Actor("owner", "company", "b"), query="NEEDLE", include_proposed=True)
    assert [(record.id, record.content) for record in records] == [(shared.id, "Shared needle")]
    assert await context(sf, Actor("owner", "company", "b"), query="secret-design") == []


async def test_runtime_never_silently_truncates_pinned_constraints(memory):
    from app.services.scoped_memory import runtime_context
    sf, owner, _ = memory
    record = await owner_put(sf, owner, Target("project", "company"), "critical", "A" * 17000, expected_version=0, pinned=True)
    with pytest.raises(MemoryConflict, match="Pinned constraints exceed"):
        await runtime_context(sf, "owner", "company", "a", "run")
    assert len((await get(sf, owner, record.id)).content) == 17000
