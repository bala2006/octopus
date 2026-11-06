"""Message delivery: posting messages, mailbox queues, observations, and requeuing a failed turn's messages."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from app.storage.base import new_id, utcnow
from app.storage.repositories import MessageRepository
from app.storage.models import Message

if TYPE_CHECKING:  # pragma: no cover
    from app.kernel.runtime.engine import RunRuntime


MAX_REDELIVERIES = 2  # a message whose turn failed is shown again at most this many times


def deliver(rt: RunRuntime, aid: str, mid: str) -> None:
    rt.seq += 1
    rt.mailbox.setdefault(aid, []).append((rt.seq, mid))


def observe(rt: RunRuntime, aid: str, obs: dict[str, Any], *, activate: bool = True) -> None:
    rt.seq += 1
    obs = {**obs, "activate": activate}
    rt.observations.setdefault(aid, []).append((rt.seq, obs))


def notice(rt: RunRuntime, aid: str, text: str, *, activate: bool = False) -> None:
    rt.observe(aid, {"tool": "system", "content": text}, activate=activate)


async def post_message(rt: RunRuntime, *, sender: str, from_id: str | None, to_id: str | None, type_: str, content: str,
                       edge_id: str | None = None, meta: dict[str, Any] | None = None, deliver: bool = True,
                       announce: bool = True) -> dict[str, Any]:
    m = Message(id=new_id(), run_id=rt.run_id, session_id=rt.session_id, sender=sender, from_agent_id=from_id,
                to_agent_id=to_id, edge_id=edge_id, type=type_, content=content, meta_json=meta or {},
                turn_no=rt.turn_no, read=not (deliver and to_id in rt.agents), created_at=utcnow())
    async with rt.db() as db:
        MessageRepository(db).add(m)
        await db.commit()
    rec = rt._rec(m)
    rt.history.append(rec)
    if deliver and to_id in rt.agents:
        rt.deliver(to_id, m.id)
        if to_id in rt.done_agents:
            rt.done_agents.discard(to_id)
        if rt.status.get(to_id) in ("idle", "done"):
            await rt.set_agent_status(to_id, "waiting")
    if announce:
        await rt.announce_message(rec, m.created_at.isoformat())
    return rec


async def announce_message(rt: RunRuntime, m: dict[str, Any], created_at: str, *, to_everyone: bool = False) -> None:
    """Show a message in the run (feed, timeline, canvas). A broadcast's per-agent copies are announced once, to everyone."""
    await rt.emit("message_created", {"message": {
        "id": m["id"], "run_id": rt.run_id, "session_id": rt.session_id, "sender": m["sender"], "from_agent_id": m["from"],
        "to_agent_id": None if to_everyone else m["to"], "edge_id": m["edge_id"], "type": m["type"], "content": m["content"],
        "meta": m["meta"], "turn_no": m["turn"], "created_at": created_at}})


async def requeue(rt: RunRuntime, aid: str, inbox_ids: list[str]) -> bool:
    """A turn failed before the agent could act on its messages: deliver them again, so they stay NEW instead of silently
        sliding into history (the agent then lost track of what it was asked and re-asked or looped). Bounded per message."""
    again = [mid for mid in inbox_ids if rt.redeliveries[mid] < MAX_REDELIVERIES]
    if not again:
        return False
    for mid in again:
        rt.redeliveries[mid] += 1
        rt.deliver(aid, mid)
    async with rt.db() as db:
        await MessageRepository(db).set_read(again, False)
        await db.commit()
    return True
