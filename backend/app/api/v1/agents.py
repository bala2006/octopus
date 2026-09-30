from __future__ import annotations

from fastapi.responses import Response
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import current_user, get_pdb, owned_company
from app.db.base import utcnow
from app.models import Agent, AgentMemory, Edge, User
from app.schemas import AgentIn, AgentOut, AgentPatch, EdgeIn, EdgeOut, MemoryIn, MemoryOut
from app.services.canvas import agent_out, apply_agent, edge_out, validate_edges

router = APIRouter(tags=["agents & edges"])


async def owned_agent(agent_id: str, db: AsyncSession, user: User) -> Agent:
    a = await db.get(Agent, agent_id)
    if a is None:
        raise HTTPException(404, "Agent not found")
    await owned_company(a.company_id, db, user)
    return a


@router.get("/companies/{company_id}/agents", response_model=list[AgentOut])
async def list_agents(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[AgentOut]:
    c = await owned_company(company_id, db, user)
    return [agent_out(a) for a in c.agents]


@router.post("/companies/{company_id}/agents", response_model=AgentOut, status_code=201)
async def create_agent(company_id: str, body: AgentIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> AgentOut:
    c = await owned_company(company_id, db, user)
    a = Agent(company_id=c.id) if not body.id else Agent(id=body.id, company_id=c.id)
    apply_agent(a, body)
    db.add(a)
    c.updated_at = utcnow()
    await db.commit()
    await db.refresh(a)
    return agent_out(a)


@router.get("/agents/{agent_id}", response_model=AgentOut)
async def get_agent(agent_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> AgentOut:
    return agent_out(await owned_agent(agent_id, db, user))


@router.patch("/agents/{agent_id}", response_model=AgentOut)
async def patch_agent(agent_id: str, body: AgentPatch, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> AgentOut:
    a = await owned_agent(agent_id, db, user)
    current = agent_out(a).model_dump()
    current.update({k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None})
    apply_agent(a, AgentIn(**current))
    await db.commit()
    await db.refresh(a)
    return agent_out(a)


@router.delete("/agents/{agent_id}", status_code=204, response_class=Response, response_model=None)
async def delete_agent(agent_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    a = await owned_agent(agent_id, db, user)
    await db.delete(a)
    await db.commit()


# ---- memory
@router.get("/agents/{agent_id}/memory", response_model=list[MemoryOut])
async def list_memory(agent_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[AgentMemory]:
    await owned_agent(agent_id, db, user)
    return list((await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id).order_by(AgentMemory.key))).scalars().all())


@router.put("/agents/{agent_id}/memory", response_model=MemoryOut)
async def put_memory(agent_id: str, body: MemoryIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> AgentMemory:
    await owned_agent(agent_id, db, user)
    row = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id, AgentMemory.key == body.key))).scalar_one_or_none()
    if row is None:
        row = AgentMemory(agent_id=agent_id, key=body.key, value=body.value)
        db.add(row)
    else:
        row.value = body.value
    await db.commit()
    await db.refresh(row)
    return row


@router.delete("/agents/{agent_id}/memory/{key}", status_code=204, response_class=Response, response_model=None)
async def delete_memory(agent_id: str, key: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    await owned_agent(agent_id, db, user)
    row = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent_id, AgentMemory.key == key))).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()


# ---- edges
@router.get("/companies/{company_id}/edges", response_model=list[EdgeOut])
async def list_edges(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[EdgeOut]:
    c = await owned_company(company_id, db, user)
    return [edge_out(e) for e in c.edges]


@router.post("/companies/{company_id}/edges", response_model=EdgeOut, status_code=201)
async def create_edge(company_id: str, body: EdgeIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> EdgeOut:
    c = await owned_company(company_id, db, user)
    existing = [EdgeIn(**edge_out(e).model_dump(exclude={"company_id"})) for e in c.edges]
    validate_edges({a.id for a in c.agents}, existing + [body])
    e = Edge(company_id=c.id, source_agent_id=body.source_agent_id, target_agent_id=body.target_agent_id, bidirectional=body.bidirectional,
             type=body.type, label=body.label, config_json=body.config.model_dump())
    if body.id:
        e.id = body.id
    db.add(e)
    await db.commit()
    await db.refresh(e)
    return edge_out(e)


@router.patch("/edges/{edge_id}", response_model=EdgeOut)
async def patch_edge(edge_id: str, body: EdgeIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> EdgeOut:
    e = await db.get(Edge, edge_id)
    if e is None:
        raise HTTPException(404, "Edge not found")
    c = await owned_company(e.company_id, db, user)
    others = [EdgeIn(**edge_out(x).model_dump(exclude={"company_id"})) for x in c.edges if x.id != edge_id]
    validate_edges({a.id for a in c.agents}, others + [body])
    e.source_agent_id, e.target_agent_id, e.bidirectional = body.source_agent_id, body.target_agent_id, body.bidirectional
    e.type, e.label, e.config_json = body.type, body.label, body.config.model_dump()
    await db.commit()
    await db.refresh(e)
    return edge_out(e)


@router.delete("/edges/{edge_id}", status_code=204, response_class=Response, response_model=None)
async def delete_edge(edge_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    e = await db.get(Edge, edge_id)
    if e is None:
        raise HTTPException(404, "Edge not found")
    await owned_company(e.company_id, db, user)
    await db.delete(e)
    await db.commit()
