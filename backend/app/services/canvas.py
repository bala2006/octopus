"""Canvas <-> DB synchronisation, validation and (de)serialisation."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import new_id, utcnow
from app.models import Agent, Company, Edge
from app.schemas import AgentBehavior, AgentIn, AgentOut, AgentTools, CanvasOut, CompanyOut, DepartmentMeta, EdgeConfig, EdgeIn, EdgeOut


def agent_out(a: Agent) -> AgentOut:
    return AgentOut(
        id=a.id, company_id=a.company_id, name=a.name, role=a.role, description=a.description, avatar=a.avatar,
        color=a.color, system_prompt=a.system_prompt, provider=a.provider, model=a.model, temperature=a.temperature,
        max_tokens=a.max_tokens, tools=AgentTools(**(a.tools_json or {})), behavior=AgentBehavior(**(a.behavior_json or {})),
        permission_level=a.permission_level or "inherit",  # type: ignore[arg-type]
        department=a.department or "", is_manager=bool(a.is_manager), reports_to=a.reports_to, active=a.active is not False,
        created_by=a.created_by,
        is_entry=a.is_entry, position_x=a.position_x, position_y=a.position_y,
    )


def edge_out(e: Edge) -> EdgeOut:
    return EdgeOut(
        id=e.id, company_id=e.company_id, source_agent_id=e.source_agent_id, target_agent_id=e.target_agent_id,
        bidirectional=e.bidirectional, type=e.type, label=e.label, config=EdgeConfig(**(e.config_json or {})),  # type: ignore[arg-type]
    )


def company_out(c: Company) -> CompanyOut:
    return CompanyOut(id=c.id, name=c.name, description=c.description, created_at=c.created_at,
                      updated_at=c.updated_at, agent_count=len(c.agents))


def departments_of(c: Company) -> dict[str, DepartmentMeta]:
    """Department metadata (colors) for every department used by an agent; stable defaults for new ones."""
    stored = (c.canvas_json or {}).get("departments") or {}
    out: dict[str, DepartmentMeta] = {}
    for a in c.agents:
        d = a.department or ""
        if d and d not in out:
            out[d] = DepartmentMeta(**stored[d]) if d in stored else DepartmentMeta(color=department_color(d))
    return out


PALETTE = ["#8b5cf6", "#06b6d4", "#10b981", "#f59e0b", "#ec4899", "#0ea5e9", "#ef4444", "#84cc16", "#f97316", "#6366f1"]


def department_color(name: str) -> str:
    return PALETTE[sum(map(ord, name)) % len(PALETTE)]


def canvas_out(c: Company) -> CanvasOut:
    return CanvasOut(
        company=company_out(c), agents=[agent_out(a) for a in c.agents], edges=[edge_out(e) for e in c.edges],
        viewport=(c.canvas_json or {}).get("viewport"), departments=departments_of(c), revision=c.revision or 0,
    )


def validate_edges(agent_ids: set[str], edges: list[EdgeIn]) -> None:
    """Server-side connection rules: known endpoints, no self loops, no duplicate edges of same type."""
    seen: set[tuple[str, str, str]] = set()
    for e in edges:
        if e.source_agent_id not in agent_ids or e.target_agent_id not in agent_ids:
            raise HTTPException(422, f"Edge references unknown agent ({e.source_agent_id} → {e.target_agent_id})")
        if e.source_agent_id == e.target_agent_id:
            raise HTTPException(422, "Self-loops are not allowed")
        key = (e.source_agent_id, e.target_agent_id, e.type)
        rev = (e.target_agent_id, e.source_agent_id, e.type)
        if key in seen or (rev in seen and e.bidirectional):
            raise HTTPException(422, f"Duplicate {e.type} edge between the same agents")
        seen.add(key)
        if e.bidirectional:
            seen.add(rev)


def apply_agent(a: Agent, data: AgentIn) -> None:
    a.name, a.role, a.description = data.name, data.role, data.description
    a.avatar, a.color, a.system_prompt = data.avatar, data.color, data.system_prompt
    a.provider, a.model, a.temperature, a.max_tokens = data.provider, data.model, data.temperature, data.max_tokens
    a.tools_json = data.tools.model_dump()
    a.behavior_json = data.behavior.model_dump()
    a.is_entry = data.is_entry
    a.permission_level = data.permission_level
    a.department = data.department.strip()
    a.is_manager = data.is_manager
    a.reports_to = data.reports_to if data.reports_to != data.id else None
    a.active = data.active
    a.created_by = data.created_by
    a.position_x, a.position_y = data.position_x, data.position_y


class RevisionConflict(HTTPException):
    def __init__(self, current: int) -> None:
        super().__init__(409, {"message": "The team was changed elsewhere (e.g. agents hired or edited teammates during a run). Reload to continue.",
                               "revision": current})


async def sync_canvas(db: AsyncSession, company: Company, agents: list[AgentIn], edges: list[EdgeIn],
                      viewport: dict[str, float] | None = None, *, departments: dict[str, DepartmentMeta] | None = None,
                      expected_revision: int | None = None) -> Company:
    for a in agents:
        a.id = a.id or new_id()
    validate_edges({a.id for a in agents if a.id}, edges)
    await db.refresh(company, attribute_names=["agents", "edges", "revision", "canvas_json"])
    if expected_revision is not None and expected_revision != (company.revision or 0):
        raise RevisionConflict(company.revision or 0)
    ids = {a.id for a in agents}
    for a in agents:  # dangling org references are dropped rather than rejected
        if a.reports_to and (a.reports_to not in ids or a.reports_to == a.id):
            a.reports_to = None

    existing_agents = {a.id: a for a in company.agents}
    incoming_ids = {a.id for a in agents}
    for aid, a in list(existing_agents.items()):
        if aid not in incoming_ids:
            company.agents.remove(a)
    # guard against ids belonging to other companies
    foreign = (await db.execute(select(Agent.id).where(Agent.id.in_(incoming_ids), Agent.company_id != company.id))).scalars().all()
    if foreign:
        raise HTTPException(409, "Agent id belongs to another company")
    for data in agents:
        a = existing_agents.get(data.id or "")
        if a is None:
            a = Agent(id=data.id, company_id=company.id)
            company.agents.append(a)
        apply_agent(a, data)

    existing_edges = {e.id: e for e in company.edges}
    incoming_edges = {e.id or new_id(): e for e in edges}
    for eid, e in list(existing_edges.items()):
        if eid not in incoming_edges:
            company.edges.remove(e)
    await db.flush()  # make sure agents exist before FK'd edges
    foreign_e = (await db.execute(select(Edge.id).where(Edge.id.in_(list(incoming_edges)), Edge.company_id != company.id))).scalars().all()
    if foreign_e:
        raise HTTPException(409, "Edge id belongs to another company")
    for eid, data in incoming_edges.items():
        e = existing_edges.get(eid)
        if e is None:
            e = Edge(id=eid, company_id=company.id)
            company.edges.append(e)
        e.source_agent_id, e.target_agent_id = data.source_agent_id, data.target_agent_id
        e.bidirectional, e.type, e.label = data.bidirectional, data.type, data.label
        e.config_json = data.config.model_dump()

    cj = dict(company.canvas_json or {})
    if viewport is not None:
        cj["viewport"] = viewport
    if departments is not None:
        cj["departments"] = {k: v.model_dump() for k, v in departments.items() if k}
    company.canvas_json = cj
    company.revision = (company.revision or 0) + 1
    company.updated_at = utcnow()
    await db.commit()
    await db.refresh(company, attribute_names=["agents", "edges", "updated_at", "name", "description", "canvas_json", "created_at", "revision"])
    return company


def snapshot(company: Company) -> dict[str, Any]:
    """Frozen copy of the company graph used by a run."""
    return {
        "company": {"id": company.id, "name": company.name, "description": company.description},
        "agents": [agent_out(a).model_dump() for a in company.agents],
        "departments": {k: v.model_dump() for k, v in departments_of(company).items()},
        "edges": [edge_out(e).model_dump() for e in company.edges],
    }
