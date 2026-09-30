from __future__ import annotations

from fastapi.responses import Response
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user, get_pdb, owned_company
from app.db.base import new_id
from app.models import Company, User
from app.schemas import (
    AgentIn, CanvasExport, CanvasOut, CanvasState, CompanyIn, CompanyOut, CompanyPatch, EdgeIn, InstantiateTemplateIn,
)
from app.services.canvas import agent_out, canvas_out, company_out, edge_out, sync_canvas
from app.services.templates import TEMPLATES, build_template

router = APIRouter(prefix="/companies", tags=["companies"])


@router.get("", response_model=list[CompanyOut])
async def list_companies(db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[CompanyOut]:
    rows = (await db.execute(select(Company).where(Company.user_id == user.id).order_by(Company.updated_at.desc()))).scalars().all()
    return [company_out(c) for c in rows]


@router.post("", response_model=CanvasOut, status_code=201)
async def create_company(body: CompanyIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    c = Company(user_id=user.id, name=body.name, description=body.description, canvas_json={})
    db.add(c)
    await db.commit()
    await db.refresh(c, attribute_names=["agents", "edges", "created_at", "updated_at"])
    return canvas_out(c)


async def instantiate(db: AsyncSession, user: User, key: str, name: str | None = None) -> Company:
    if key not in TEMPLATES:
        raise HTTPException(404, "Unknown template")
    t = TEMPLATES[key]
    c = Company(user_id=user.id, name=name or t.name, description=t.description, canvas_json={})
    db.add(c)
    await db.flush()
    agents, edges = build_template(key)
    return await sync_canvas(db, c, [AgentIn(**a) for a in agents], [EdgeIn(**e) for e in edges])


@router.post("/from-template", response_model=CanvasOut, status_code=201)
async def create_from_template(body: InstantiateTemplateIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    return canvas_out(await instantiate(db, user, body.template_key, body.name))


@router.get("/{company_id}", response_model=CanvasOut)
async def get_company(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    return canvas_out(await owned_company(company_id, db, user))


@router.patch("/{company_id}", response_model=CompanyOut)
async def patch_company(company_id: str, body: CompanyPatch, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CompanyOut:
    c = await owned_company(company_id, db, user)
    if body.name is not None:
        c.name = body.name
    if body.description is not None:
        c.description = body.description
    await db.commit()
    await db.refresh(c)
    return company_out(c)


@router.delete("/{company_id}", status_code=204, response_class=Response, response_model=None)
async def delete_company(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    c = await owned_company(company_id, db, user)
    await db.delete(c)
    await db.commit()


@router.put("/{company_id}/canvas", response_model=CanvasOut)
async def save_canvas(company_id: str, body: CanvasState, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    """Full canvas sync: upserts agents/edges by id and deletes those not present."""
    c = await owned_company(company_id, db, user)
    return canvas_out(await sync_canvas(db, c, body.agents, body.edges, body.viewport))


@router.get("/{company_id}/export", response_model=CanvasExport)
async def export_company(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasExport:
    c = await owned_company(company_id, db, user)
    return CanvasExport(
        name=c.name, description=c.description,
        agents=[AgentIn(**agent_out(a).model_dump(exclude={"company_id"})) for a in c.agents],
        edges=[EdgeIn(**edge_out(e).model_dump(exclude={"company_id"})) for e in c.edges],
    )


@router.post("/import", response_model=CanvasOut, status_code=201)
async def import_company(body: CanvasExport, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    """Import an exported company. Ids are re-generated so the same file can be imported many times."""
    lookup: dict[str, str] = {}
    agents = []
    for a in body.agents:
        new = new_id()
        if a.id:
            lookup[a.id] = new
        agents.append(a.model_copy(update={"id": new}))
    edges = []
    for e in body.edges:
        if e.source_agent_id not in lookup or e.target_agent_id not in lookup:
            raise HTTPException(422, "Edge references an agent that is not in the file")
        edges.append(e.model_copy(update={"id": new_id(), "source_agent_id": lookup[e.source_agent_id], "target_agent_id": lookup[e.target_agent_id]}))
    c = Company(user_id=user.id, name=body.name, description=body.description, canvas_json={})
    db.add(c)
    await db.flush()
    return canvas_out(await sync_canvas(db, c, agents, edges))
