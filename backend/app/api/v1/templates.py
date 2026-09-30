"""Template library: built-in department templates + user-designed templates (stored in the global registry)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user
from app.db.session import get_registry_db
from app.models import User, UserTemplate
from app.prompts.roles import all_roles
from app.schemas import AgentTools, CanvasExport, DepartmentSummary, RoleTemplateOut, TemplateOut, UserTemplateIn
from app.services.templates import TEMPLATES, build_from_template, summarize_departments, template_summary

router = APIRouter(prefix="/templates", tags=["templates"])
USER_PREFIX = "user:"


def user_template_out(t: UserTemplate) -> TemplateOut:
    spec = CanvasExport(**t.spec_json)
    agents = [a.model_dump() for a in spec.agents]
    meta = {k: v.model_dump() for k, v in spec.departments.items()}
    return TemplateOut(key=USER_PREFIX + t.id, name=t.name, description=t.description, agent_count=len(spec.agents), edge_count=len(spec.edges),
                       source="user", departments=[DepartmentSummary(**d) for d in summarize_departments(agents, meta)], updated_at=t.updated_at)


def builtin_spec(key: str) -> CanvasExport:
    t = TEMPLATES[key]
    agents, edges, meta = build_from_template(t)
    return CanvasExport(name=t.name, description=t.description, agents=agents, edges=edges, departments=meta)  # type: ignore[arg-type]


async def resolve_spec(key: str, db: AsyncSession, user: User) -> CanvasExport:
    if key.startswith(USER_PREFIX):
        row = await db.get(UserTemplate, key[len(USER_PREFIX):])
        if row is None or row.user_id != user.id:
            raise HTTPException(404, "Template not found")
        return CanvasExport(**row.spec_json)
    if key not in TEMPLATES:
        raise HTTPException(404, "Unknown template")
    return builtin_spec(key)


@router.get("", response_model=list[TemplateOut])
async def list_templates(db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> list[TemplateOut]:
    builtins = [TemplateOut(**template_summary(t)) for t in TEMPLATES.values()]
    rows = (await db.execute(select(UserTemplate).where(UserTemplate.user_id == user.id).order_by(UserTemplate.updated_at.desc()))).scalars().all()
    return builtins + [user_template_out(r) for r in rows]


@router.get("/roles", response_model=list[RoleTemplateOut])
async def list_roles() -> list[RoleTemplateOut]:
    return [RoleTemplateOut(key=r.key, role=r.role, default_name=r.default_name, color=r.color, avatar=r.avatar,
                            description=r.description, system_prompt=r.system_prompt, tools=AgentTools(**r.tools) if r.tools else AgentTools())
            for r in all_roles().values()]


@router.get("/{key}/spec", response_model=CanvasExport)
async def template_spec(key: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> CanvasExport:
    """Full template (agents, channels, departments) for previews and export."""
    return await resolve_spec(key, db, user)


@router.post("", response_model=TemplateOut, status_code=201)
async def create_template(body: UserTemplateIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> TemplateOut:
    """Import a template spec (JSON). To save an existing company use POST /w/{ws}/companies/{id}/save-template."""
    if body.spec is None:
        raise HTTPException(422, "Provide a template spec")
    row = UserTemplate(user_id=user.id, name=body.name.strip(), description=body.description, spec_json=body.spec.model_dump())
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return user_template_out(row)


@router.patch("/{key}", response_model=TemplateOut)
async def update_template(key: str, body: UserTemplateIn, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> TemplateOut:
    row = await db.get(UserTemplate, key.removeprefix(USER_PREFIX))
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Built-in templates are read-only; save a copy instead")
    row.name, row.description = body.name.strip(), body.description
    if body.spec is not None:
        row.spec_json = body.spec.model_dump()
    await db.commit()
    await db.refresh(row)
    return user_template_out(row)


@router.delete("/{key}", status_code=204, response_class=Response, response_model=None)
async def delete_template(key: str, db: AsyncSession = Depends(get_registry_db), user: User = Depends(current_user)) -> None:
    row = await db.get(UserTemplate, key.removeprefix(USER_PREFIX))
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Template not found")
    await db.delete(row)
    await db.commit()
