from __future__ import annotations

from fastapi.responses import Response
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import ProjectCtx, current_user, get_pdb, owned_company, project_ctx
from app.db.base import new_id
from app.models import Company, User
from app.schemas import (
    AgentIn, CanvasExport, CanvasOut, CanvasState, CompanyIn, CompanyOut, CompanyPatch, DepartmentSummary, EdgeIn, GenerateCompanyIn,
    GenerateCompanyOut, InstantiateTemplateIn, TemplateOut, UserTemplateIn,
)
from app.services.canvas import agent_out, canvas_out, company_out, departments_of, edge_out, sync_canvas
from app.api.v1.templates import resolve_spec, user_template_out
from app.db.session import get_registry_db
from app.models import UserTemplate
from app.services.org_generator import generate_org, spec_to_canvas
from app.services.templates import summarize_departments

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


async def create_from_spec(db: AsyncSession, user: User, spec: CanvasExport, name: str | None = None) -> Company:
    """Create a company from a spec. All ids (agents, edges, org references) are re-generated."""
    lookup: dict[str, str] = {}
    agents = []
    for a in spec.agents:
        new = new_id()
        if a.id:
            lookup[a.id] = new
        agents.append(a.model_copy(update={"id": new}))
    agents = [a.model_copy(update={"reports_to": lookup.get(a.reports_to or ""), "created_by": lookup.get(a.created_by or "")}) for a in agents]
    edges = []
    for e in spec.edges:
        if e.source_agent_id not in lookup or e.target_agent_id not in lookup:
            raise HTTPException(422, "Edge references an agent that is not in the template")
        edges.append(e.model_copy(update={"id": new_id(), "source_agent_id": lookup[e.source_agent_id], "target_agent_id": lookup[e.target_agent_id]}))
    c = Company(user_id=user.id, name=(name or spec.name).strip() or "Company", description=spec.description, canvas_json={})
    db.add(c)
    await db.flush()
    return await sync_canvas(db, c, agents, edges, departments=spec.departments)


@router.post("/from-template", response_model=CanvasOut, status_code=201)
async def create_from_template(body: InstantiateTemplateIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                               rdb: AsyncSession = Depends(get_registry_db)) -> CanvasOut:
    """Instantiate a built-in (``software_startup``) or user template (``user:<id>``)."""
    spec = await resolve_spec(body.template_key, rdb, user)
    return canvas_out(await create_from_spec(db, user, spec, body.name))


@router.post("/generate", response_model=GenerateCompanyOut)
async def generate_company(body: GenerateCompanyIn, user: User = Depends(current_user), rdb: AsyncSession = Depends(get_registry_db),
                           _ctx: ProjectCtx = Depends(project_ctx)) -> GenerateCompanyOut:
    """Design a company (departments, managers, specialists, prompts, tools, channels) from a prompt. Not saved:
    review the preview, then POST it to /companies/import (or save it as a template)."""
    spec, source, warning = await generate_org(rdb, user.id, body.prompt, body.max_agents, body.provider, body.model)
    agents, edges, meta = spec_to_canvas(spec, body.max_agents)
    export = CanvasExport(name=spec.name, description=spec.description, agents=agents, edges=edges, departments=meta)  # type: ignore[arg-type]
    return GenerateCompanyOut(spec=export, departments=[DepartmentSummary(**d) for d in summarize_departments(agents, meta)],
                              source=source, warning=warning)


@router.post("/{company_id}/save-template", response_model=TemplateOut, status_code=201)
async def save_as_template(company_id: str, body: UserTemplateIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user),
                           rdb: AsyncSession = Depends(get_registry_db)) -> TemplateOut:
    """Save a company's current org (departments, agents, prompts, tools, channels) as a reusable template."""
    c = await owned_company(company_id, db, user)
    export = CanvasExport(
        name=body.name, description=body.description or c.description, departments=departments_of(c),
        agents=[AgentIn(**agent_out(a).model_dump(exclude={"company_id"})) for a in c.agents],
        edges=[EdgeIn(**edge_out(e).model_dump(exclude={"company_id"})) for e in c.edges],
    )
    row = UserTemplate(user_id=user.id, name=body.name.strip(), description=export.description, spec_json=export.model_dump())
    rdb.add(row)
    await rdb.commit()
    await rdb.refresh(row)
    return user_template_out(row)


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
    return canvas_out(await sync_canvas(db, c, body.agents, body.edges, body.viewport, departments=body.departments,
                                        expected_revision=body.revision))


@router.get("/{company_id}/export", response_model=CanvasExport)
async def export_company(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasExport:
    c = await owned_company(company_id, db, user)
    return CanvasExport(
        name=c.name, description=c.description,
        agents=[AgentIn(**agent_out(a).model_dump(exclude={"company_id"})) for a in c.agents],
        edges=[EdgeIn(**edge_out(e).model_dump(exclude={"company_id"})) for e in c.edges],
        departments=departments_of(c),
    )


@router.post("/import", response_model=CanvasOut, status_code=201)
async def import_company(body: CanvasExport, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> CanvasOut:
    """Import an exported / generated company. Ids are re-generated so the same file can be imported many times."""
    return canvas_out(await create_from_spec(db, user, body))
