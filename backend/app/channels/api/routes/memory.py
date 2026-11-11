"""Authenticated owner controls for scoped application memory. Agents use the service, never owner endpoints."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.storage.repositories import MemoryRepository, RunRepository
from app.channels.deps import ProjectCtx, current_user, get_pdb, owned_company, project_ctx
from app.storage.models import User
from app.plugins.memory import scoped as memory

router = APIRouter(prefix="/memory", tags=["memory"])


class SourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)
    kind: Literal["memory", "message", "artifact"]
    id: str = Field(min_length=1, max_length=100)


class ScopedMemoryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: memory.Scope
    scope_id: str = Field(min_length=1, max_length=36)
    run_id: str | None = None
    key: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=50000)
    expected_version: int = Field(ge=0)
    sources: list[SourceIn] = Field(default_factory=list, max_length=100)
    classification: memory.Classification = "proposed"
    pinned: bool = False
    share_sources: bool = False


class ScopedMemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    key: str
    version: int
    scope: str
    scope_id: str
    run_id: str | None = None
    content: str
    classification: str
    pinned: bool
    source_refs: list[SourceIn]


class GroupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    members: list[str] = Field(min_length=1, max_length=100)


class GroupPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    members: list[str] | None = Field(default=None, max_length=100)
    active: bool | None = None


class GroupOut(BaseModel):
    id: str
    name: str
    members: list[str]
    active: bool


async def owner(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> memory.Actor:
    company = await owned_company(company_id, db, user)
    return memory.Actor(user.id, company.id)


def failure(exc: Exception) -> HTTPException:
    return HTTPException(409 if isinstance(exc, memory.MemoryConflict) else 404 if isinstance(exc, memory.MemoryDenied) else 422,
                         str(exc))


@router.get("", response_model=list[ScopedMemoryOut])
async def list_memory(actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx),
                      run_id: str | None = None, include_proposed: bool = True,
                      limit: int = Query(40, ge=1, le=200), query: str = Query("", max_length=200)):
    try:
        return await memory.context(ctx.sf, actor, run_id=run_id, include_proposed=include_proposed, limit=limit, query=query)
    except (memory.MemoryDenied, ValueError) as exc:
        raise failure(exc) from exc


@router.put("", response_model=ScopedMemoryOut)
async def put_memory(body: ScopedMemoryIn, actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx)):
    try:
        record = await memory.owner_put(ctx.sf, actor, memory.Target(body.scope, body.scope_id, body.run_id), body.key, body.content,
            expected_version=body.expected_version, refs=tuple(memory.SourceRef(source.kind, source.id) for source in body.sources),
            classification=body.classification, pinned=body.pinned, share_sources=body.share_sources)
        if body.classification == "deleted":
            return ScopedMemoryOut(id=record.id, key=body.key, version=record.version, scope=body.scope, scope_id=body.scope_id, run_id=body.run_id, content="", classification="deleted",
                             pinned=record.pinned, source_refs=body.sources)
        return await memory.get(ctx.sf, actor, record.id)
    except (memory.MemoryDenied, ValueError) as exc:
        raise failure(exc) from exc


@router.get("/groups", response_model=list[GroupOut])
async def list_groups(actor: memory.Actor = Depends(owner), db: AsyncSession = Depends(get_pdb)):
    groups = await MemoryRepository(db).groups_for_company(actor.company_id)
    return [GroupOut(id=group.id, name=group.name, active=group.active,
        members=await MemoryRepository(db).group_member_ids(group.id))
        for group in groups]


@router.post("/groups", response_model=GroupOut, status_code=201)
async def create_group(body: GroupIn, actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx)):
    try:
        gid = await memory.owner_group(ctx.sf, actor, body.name, body.members)
        return GroupOut(id=gid, name=body.name, members=sorted(set(body.members)), active=True)
    except (memory.MemoryDenied, ValueError) as exc:
        raise failure(exc) from exc


@router.patch("/groups/{group_id}", status_code=204, response_class=Response)
async def edit_group(group_id: str, body: GroupPatch, actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx)):
    try:
        await memory.owner_update_group(ctx.sf, actor, group_id, name=body.name, members=body.members, active=body.active)
        return Response(status_code=204)
    except (memory.MemoryDenied, ValueError) as exc:
        raise failure(exc) from exc


@router.delete("/groups/{group_id}", status_code=204, response_class=Response)
async def archive_group(group_id: str, actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx)):
    """Archive a group and revoke agent reads; preserve immutable history for the owner."""
    try:
        await memory.owner_update_group(ctx.sf, actor, group_id, active=False)
        return Response(status_code=204)
    except (memory.MemoryDenied, ValueError) as exc:
        raise failure(exc) from exc


@router.get("/versions", response_model=list[ScopedMemoryOut])
async def versions(scope: memory.Scope, scope_id: str, key: str, actor: memory.Actor = Depends(owner),
                   ctx: ProjectCtx = Depends(project_ctx), db: AsyncSession = Depends(get_pdb)):
    rows = await MemoryRepository(db).records_for_head(actor.company_id, scope, scope_id, key)
    return [await memory.get(ctx.sf, actor, record.id) for record in rows]


@router.get("/{record_id}", response_model=ScopedMemoryOut)
async def exact_memory(record_id: str, actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx)):
    try:
        return await memory.get(ctx.sf, actor, record_id)
    except memory.MemoryDenied as exc:
        raise failure(exc) from exc


@router.get("/sources/{kind}/{source_id}")
async def exact_source(kind: Literal["memory", "message", "artifact"], source_id: str,
                       actor: memory.Actor = Depends(owner), ctx: ProjectCtx = Depends(project_ctx),
                       db: AsyncSession = Depends(get_pdb)) -> dict:
    from app.sdk.evidence import redact_evidence
    if kind == "memory":
        try:
            item = await memory.get(ctx.sf, actor, source_id)
            return {"kind": kind, "id": item.id, "content": item.content, "label": item.key, "run_id": item.run_id}
        except memory.MemoryDenied as exc:
            raise failure(exc) from exc
    item = await MemoryRepository(db).source(kind, source_id)
    run = await RunRepository(db).get(item.run_id) if item else None
    if not item or not run or run.company_id != actor.company_id:
        raise HTTPException(404, "Source not found")
    value = redact_evidence(item.content)
    return {"kind": kind, "id": item.id, "run_id": item.run_id, "content": value,
            "label": item.type if kind == "message" else item.path, "truncated": len(value) < len(item.content)}
