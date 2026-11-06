from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.repositories import AgentRepository, ChatSessionRepository, MessageRepository
from app.channels.deps import current_user, get_pdb, owned_company
from app.models import ChatSession, Message, User
from app.schemas import MessageOut, SessionIn, SessionOut, SessionPatch

router = APIRouter(prefix="/sessions", tags=["sessions"])


async def owned_session(session_id: str, db: AsyncSession, user: User) -> ChatSession:
    s = await ChatSessionRepository(db).get(session_id)
    if s is None:
        raise HTTPException(404, "Session not found")
    await owned_company(s.company_id, db, user)
    return s


@router.get("", response_model=list[SessionOut])
async def list_sessions(company_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> list[ChatSession]:
    await owned_company(company_id, db, user)
    return await ChatSessionRepository(db).for_company(company_id)


@router.post("", response_model=SessionOut, status_code=201)
async def create_session(body: SessionIn, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> ChatSession:
    await owned_company(body.company_id, db, user)
    if body.mode == "direct":
        a = await AgentRepository(db).get(body.agent_id) if body.agent_id else None
        if a is None or a.company_id != body.company_id:
            raise HTTPException(422, "Direct sessions need an agent from this company")
    s = ChatSession(company_id=body.company_id, title=body.title, mode=body.mode, agent_id=body.agent_id if body.mode == "direct" else None)
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return s


@router.patch("/{session_id}", response_model=SessionOut)
async def rename_session(session_id: str, body: SessionPatch, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> ChatSession:
    s = await owned_session(session_id, db, user)
    s.title = body.title[:200] or s.title
    await db.commit()
    await db.refresh(s)
    return s


@router.delete("/{session_id}", status_code=204, response_class=Response, response_model=None)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_pdb), user: User = Depends(current_user)) -> None:
    s = await owned_session(session_id, db, user)
    await db.delete(s)
    await db.commit()


@router.get("/{session_id}/messages", response_model=list[MessageOut])
async def list_messages(session_id: str, limit: int = Query(500, le=5000), db: AsyncSession = Depends(get_pdb),
                        user: User = Depends(current_user)) -> list[Message]:
    await owned_session(session_id, db, user)
    rows = await MessageRepository(db).session_history(session_id, newest_first=True, limit=limit)
    return list(reversed(rows))


@router.get("/{session_id}/export")
async def export_session(session_id: str, format: str = Query("json", pattern="^(json|md)$"), db: AsyncSession = Depends(get_pdb),
                         user: User = Depends(current_user)) -> Response:
    s = await owned_session(session_id, db, user)
    msgs = await MessageRepository(db).session_history(session_id)
    agents = {a.id: a.name for a in await AgentRepository(db).for_company(s.company_id)}
    name = lambda aid: agents.get(aid or "", "Agent")  # noqa: E731
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in s.title)[:50] or "session"
    if format == "json":
        data = {"session": {"id": s.id, "title": s.title, "mode": s.mode, "created_at": s.created_at.isoformat()},
                "messages": [{"sender": m.sender, "from": name(m.from_agent_id) if m.from_agent_id else m.sender,
                              "to": name(m.to_agent_id) if m.to_agent_id else None, "type": m.type, "content": m.content,
                              "meta": m.meta_json, "created_at": m.created_at.isoformat()} for m in msgs]}
        return Response(json.dumps(data, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{safe}.json"'})
    lines = [f"# {s.title}", "", f"_Mode: {s.mode} · {s.created_at:%Y-%m-%d %H:%M}_", ""]
    for m in msgs:
        who = "**You**" if m.sender == "user" else f"**{name(m.from_agent_id)}**"
        to = f" → {name(m.to_agent_id)}" if m.sender == "agent" and m.to_agent_id else ""
        lines += [f"### {who}{to} · `{m.type}` · {m.created_at:%H:%M:%S}", "", (m.meta_json or {}).get("display", m.content), ""]
    return Response("\n".join(lines), media_type="text/markdown", headers={"Content-Disposition": f'attachment; filename="{safe}.md"'})
