from __future__ import annotations

from fastapi import APIRouter

from app.prompts.roles import ROLE_TEMPLATES
from app.schemas import AgentTools, RoleTemplateOut, TemplateOut
from app.services.templates import TEMPLATES

router = APIRouter(prefix="/templates", tags=["templates"])


@router.get("", response_model=list[TemplateOut])
async def list_templates() -> list[TemplateOut]:
    return [TemplateOut(key=t.key, name=t.name, description=t.description, agent_count=len(t.agents), edge_count=len(t.edges))
            for t in TEMPLATES.values()]


@router.get("/roles", response_model=list[RoleTemplateOut])
async def list_roles() -> list[RoleTemplateOut]:
    return [RoleTemplateOut(key=r.key, role=r.role, default_name=r.default_name, color=r.color, avatar=r.avatar,
                            description=r.description, system_prompt=r.system_prompt, tools=AgentTools(**r.tools) if r.tools else AgentTools())
            for r in ROLE_TEMPLATES.values()]
