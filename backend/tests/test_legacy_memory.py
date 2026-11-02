"""The Inspector memory API and runtime read the same versioned source of truth."""
from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.core.deps import get_or_create_single_user, load_project
from app.db.session import registry_factory
from app.models import Agent, AgentMemory, Company, Run
from app.models.scoped_memory import MemoryHead, MemoryRecord
from app.services import scoped_memory as memory
from conftest import agent, make_company


async def setup_memory(client, workspace):
    company = await make_company(client, workspace, [agent("lead", "Lead", entry=True), agent("peer", "Peer")], [])
    async with registry_factory()() as db:
        user = await get_or_create_single_user(db)
        ctx = await load_project(workspace["id"], user, db)
    async with ctx.sf() as db, db.begin():
        run = Run(company_id=company, goal="Read memory")
        db.add(run)
        await db.flush()
        run_id = run.id
    return ctx, company, run_id, f"/api/v1/w/{workspace['id']}/agents/lead/memory"


async def test_legacy_owner_crud_updates_next_context_without_mutating_archive(client, workspace):
    ctx, company, run, url = await setup_memory(client, workspace)
    async with ctx.sf() as db, db.begin():
        db.add(AgentMemory(id="archive", agent_id="lead", key="style", value="Archived instruction"))
    listed = await client.get(url)
    assert listed.status_code == 200 and listed.json()[0]["value"] == "Archived instruction"
    assert "Archived instruction" in await memory.runtime_context(ctx.sf, ctx.user.id, company, "lead", run)
    edited = await client.put(url, json={"key": "style", "value": "Current instruction"})
    assert edited.status_code == 200, edited.text
    assert set(edited.json()) == {"id", "agent_id", "key", "value", "updated_at"}
    assert edited.json()["id"] != listed.json()[0]["id"]
    context = await memory.runtime_context(ctx.sf, ctx.user.id, company, "lead", run)
    assert "Current instruction" in context and "Archived instruction" not in context
    assert "Current instruction" not in await memory.runtime_context(ctx.sf, ctx.user.id, company, "peer", run)
    assert (await client.delete(f"{url}/style")).status_code == 204
    assert (await client.get(url)).json() == [], "Idempotent import must not resurrect a tombstone"
    assert "instruction" not in await memory.runtime_context(ctx.sf, ctx.user.id, company, "lead", run)
    assert (await client.delete(f"{url}/style")).status_code == 204
    async with ctx.sf() as db:
        assert (await db.get(AgentMemory, "archive")).value == "Archived instruction"
        records = (await db.scalars(select(MemoryRecord).order_by(MemoryRecord.version))).all()
        assert [(record.version, record.classification) for record in records] == [(1, "proposed"), (2, "verified"), (3, "deleted")]
        assert [record.content for record in records] == ["Archived instruction", "Current instruction", ""]


async def test_legacy_edit_preserves_pinning_provenance_and_run_binding(client, workspace):
    ctx, company, run, url = await setup_memory(client, workspace)
    owner = memory.Actor(ctx.user.id, company)
    source = await memory.owner_put(ctx.sf, owner, memory.Target("agent", "lead"), "source", "Original requirement", expected_version=0)
    refs = (memory.SourceRef("memory", source.id),)
    pinned = await memory.owner_put(ctx.sf, owner, memory.Target("agent", "lead", run), "constraint", "Original constraint",
                                    expected_version=0, pinned=True, refs=refs)
    edited = await client.put(url, json={"key": "constraint", "value": "Updated constraint"})
    assert edited.status_code == 200, edited.text
    async with ctx.sf() as db:
        record = await db.get(MemoryRecord, edited.json()["id"])
        assert record.version == 2 and record.pinned and record.classification == "verified"
        assert record.source_refs == [{"kind": "memory", "id": source.id}] and record.run_id == run
    assert (await memory.get(ctx.sf, owner, pinned.id)).content == "Original constraint"
    assert "Updated constraint" in await memory.runtime_context(ctx.sf, ctx.user.id, company, "lead", run)
    assert "Updated constraint" not in " ".join(item.content for item in await memory.context(ctx.sf, owner))
    assert (await client.delete(f"{url}/constraint")).status_code == 204
    async with ctx.sf() as db:
        head = await db.scalar(select(MemoryHead).where(MemoryHead.company_id == company, MemoryHead.key == "constraint"))
        tombstone = await db.scalar(select(MemoryRecord).where(MemoryRecord.head_id == head.id, MemoryRecord.version == head.version))
        assert tombstone.classification == "deleted" and tombstone.run_id == run and tombstone.pinned
        assert tombstone.source_refs == record.source_refs


async def test_legacy_routes_reject_foreign_owner_before_import_or_write(client, workspace):
    ctx, company, _, url = await setup_memory(client, workspace)
    async with ctx.sf() as db, db.begin():
        foreign = Company(user_id="another-owner", name="Private")
        db.add(foreign)
        await db.flush()
        db.add(Agent(id="foreign", company_id=foreign.id, name="Private"))
        await db.flush()
        db.add(AgentMemory(id="private-archive", agent_id="foreign", key="private", value="Other owner detail"))
    foreign_url = url.replace("/lead/", "/foreign/")
    assert (await client.get(foreign_url)).status_code == 404
    assert (await client.put(foreign_url, json={"key": "private", "value": "Overwrite"})).status_code == 404
    assert (await client.delete(f"{foreign_url}/private")).status_code == 404
    assert (await client.get(url)).json() == []
    async with ctx.sf() as db:
        assert (await db.get(AgentMemory, "private-archive")).value == "Other owner detail"
        assert (await db.scalars(select(MemoryRecord))).all() == []


async def test_legacy_concurrent_edits_conflict_instead_of_overwriting_versions(client, workspace, monkeypatch):
    ctx, _, _, url = await setup_memory(client, workspace)
    assert (await client.put(url, json={"key": "rule", "value": "Initial"})).status_code == 200
    original_put = memory.owner_put
    both_read = asyncio.Event()
    arrivals = 0
    async def synchronized_put(*args, **kwargs):
        nonlocal arrivals
        arrivals += 1
        if arrivals == 2:
            both_read.set()
        await asyncio.wait_for(both_read.wait(), 5)
        return await original_put(*args, **kwargs)
    monkeypatch.setattr(memory, "owner_put", synchronized_put)
    responses = await asyncio.gather(client.put(url, json={"key": "rule", "value": "First"}),
                                     client.put(url, json={"key": "rule", "value": "Second"}))
    assert sorted(response.status_code for response in responses) == [200, 409]
    async with ctx.sf() as db:
        records = (await db.scalars(select(MemoryRecord).order_by(MemoryRecord.version))).all()
        assert [record.version for record in records] == [1, 2]
        assert records[0].content == "Initial" and records[1].content in {"First", "Second"}
        assert (await db.scalars(select(AgentMemory))).all() == [], "The archive is never a dual-write target"
