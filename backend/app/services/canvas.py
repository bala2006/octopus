"""Canvas <-> DB synchronisation, validation and (de)serialisation."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import new_id, utcnow
from app.models import Agent, Company, Edge
from app.schemas import AgentIn, AgentOut, AgentTools, AgentBehavior, CanvasOut, CompanyOut, EdgeConfig, EdgeIn, EdgeOut


def agent_out(a: Agent) -> AgentOut:
    return AgentOut(
        id=a.id, company_id=a.company_id, name=a.name, role=a.role, description=a.description, avatar=a.avatar,
        color=a.color, system_prompt=a.system_prompt, provider=a.provider, model=a.model, temperature=a.temperature,
        max_tokens=a.max_tokens, tools=AgentTools(**(a.tools_json or {})), behavior=AgentBehavior(**(a.behavior_json or {})),
        permission_level=a.permission_level or "inherit",  # type: ignore[arg-type]
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


def canvas_out(c: Company) -> CanvasOut:
    return CanvasOut(
        company=company_out(c), agents=[agent_out(a) for a in c.agents], edges=[edge_out(e) for e in c.edges],
        viewport=(c.canvas_json or {}).get("viewport"),
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
    a.position_x, a.position_y = data.position_x, data.position_y


async def sync_canvas(db: AsyncSession, company: Company, agents: list[AgentIn], edges: list[EdgeIn],
                      viewport: dict[str, float] | None = None) -> Company:
    for a in agents:
        a.id = a.id or new_id()
    validate_edges({a.id for a in agents if a.id}, edges)
    await db.refresh(company, attribute_names=["agents", "edges"])

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

    if viewport is not None:
        company.canvas_json = {**(company.canvas_json or {}), "viewport": viewport}
    company.updated_at = utcnow()
    await db.commit()
    await db.refresh(company, attribute_names=["agents", "edges", "updated_at", "name", "description", "canvas_json", "created_at"])
    return company


def snapshot(company: Company) -> dict[str, Any]:
    """Frozen copy of the company graph used by a run."""
    return {
        "company": {"id": company.id, "name": company.name, "description": company.description},
        "agents": [agent_out(a).model_dump() for a in company.agents],
        "edges": [edge_out(e).model_dump() for e in company.edges],
    }
