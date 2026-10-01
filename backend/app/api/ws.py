"""WebSocket endpoints.

/ws/w/{workspace_id}/runs/{run_id}?token=&last_seq=N
    server → client: snapshot, agent_status, agent_activity, token_stream, thought, message_created, message_rejected,
                     edge_activity, tool_call, tool_result, task_updated, artifact_updated, usage_update, protocol,
                     approval_requested, approval_resolved, turn_started, run_status, error, ping,
                     thinking_stream, browser_action (screenshot: GET /api/v1/w/{w}/runs/{run}/browser/{frame})
    client → server: interject | user_message {content, to_agent_id?, attachments?: [{filename, text}], images?: [{name, data_url}]}, control {action}, approve {approval_id, scope?},
                     reject {approval_id, reason?}, pong
    On connect every persisted event with seq > last_seq is replayed first, so reconnects lose nothing.

/ws/w/{workspace_id}/chat/{session_id}?token=
    Direct chat: user_message {content, attachments?}, stop, regenerate  →  stream_start, status, token_stream,
    stream_reset, tool_call, stream_end, message_created, message_deleted, error
"""
from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.deps import load_project, resolve_user
from app.core.logging import get_logger
from app.db.session import registry_factory
from app.models import ChatSession, Company, Run, RunEvent
from app.orchestrator.bus import bus
from app.orchestrator.engine import ProjectRef, manager
from app.services.chat import ChatConnection

router = APIRouter()
log = get_logger("ws")


async def _auth(ws: WebSocket, workspace_id: str):  # type: ignore[no-untyped-def]
    async with registry_factory()() as rdb:
        user = await resolve_user(rdb, ws.query_params.get("token"))
        if user is None:
            return None, None
        try:
            ctx = await load_project(workspace_id, user, rdb)
        except HTTPException:
            return user, None
    return user, ctx


@router.websocket("/ws/w/{workspace_id}/runs/{run_id}")
async def run_socket(ws: WebSocket, workspace_id: str, run_id: str) -> None:
    await ws.accept()
    user, ctx = await _auth(ws, workspace_id)
    if user is None or ctx is None:
        await ws.close(code=4401 if user is None else 4404)
        return
    async with ctx.sf() as db:
        run = await db.get(Run, run_id)
        company = await db.get(Company, run.company_id) if run else None
        if run is None or company is None or company.user_id != user.id:
            await ws.close(code=4404)
            return
    project = ProjectRef(workspace_id=ctx.workspace.id, root=ctx.root, sf=ctx.sf)
    try:
        last_seq = int(ws.query_params.get("last_seq", "0") or 0)
    except ValueError:
        last_seq = 0

    queue = bus.subscribe(run_id)
    sent_seq = last_seq

    async def send(event: dict[str, Any]) -> None:
        nonlocal sent_seq
        seq = event.get("seq")
        if seq is not None:
            if seq <= sent_seq:
                return
            sent_seq = seq
        await ws.send_json(event)

    try:
        rt = manager.get(run_id)
        await ws.send_json({"type": "snapshot", "run_id": run_id, "data": {
            "status": rt.run_status if rt else run.status, "live": rt is not None,
            "agent_status": rt.status if rt else (run.state_json or {}).get("status", {}),
            "activity": rt.activity if rt else {},
            "pending_approval": rt.pending_approval if rt else None, "awaiting": rt.awaiting if rt else None,
            "usage": {"tokens": rt.tokens if rt else run.tokens_used, "cost_usd": rt.cost if rt else run.cost_usd,
                      "turns": rt.turn_no if rt else run.turns}}})
        async with ctx.sf() as db:
            rows = (await db.execute(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.id > last_seq).order_by(RunEvent.id))).scalars().all()
        for r in rows:
            await send({"type": r.type, "run_id": run_id, "data": r.payload_json, "seq": r.id, "ts": r.created_at.isoformat(), "replay": True})
        await ws.send_json({"type": "replay_done", "run_id": run_id, "data": {"last_seq": sent_seq}})

        async def pump() -> None:
            while True:
                try:
                    ev = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    await ws.send_json({"type": "ping", "data": {}})
                    continue
                await send(ev)

        async def receive() -> None:
            while True:
                msg = await ws.receive_json()
                await handle_client(msg, run_id, project)

        pump_task = asyncio.create_task(pump())
        recv_task = asyncio.create_task(receive())
        done, pending = await asyncio.wait({pump_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, RuntimeError)):
                log.warning("ws_error", error=str(exc))
    except WebSocketDisconnect:
        pass
    finally:
        bus.unsubscribe(run_id, queue)
        with contextlib.suppress(Exception):
            await ws.close()


async def handle_client(msg: dict[str, Any], run_id: str, project: ProjectRef) -> None:
    kind = msg.get("type")
    if kind in (None, "pong"):
        return
    if kind in ("interject", "user_message", "continue"):
        # live run → interjection; finished run → continue it like a chat (same run, full context)
        from app.services.images import ImageError, attach_text, parse_images

        try:
            images = parse_images(msg.get("images"))
        except ImageError as exc:
            await bus.publish(run_id, "error", {"message": f"Image not sent: {exc}", "kind": "client"}, project.sf)
            return
        content = attach_text(str(msg.get("content", "")).strip()[:20000], msg.get("attachments"))
        if not content and images:
            content = "(see the attached image" + ("s)" if len(images) > 1 else ")")
        to = msg.get("to_agent_id") or None
        if content:
            for _ in range(40):
                if await manager.continue_run(run_id, project, content, to, images):
                    return
                await asyncio.sleep(0.1)
            await bus.publish(run_id, "error", {"message": "Run could not be continued", "kind": "client"}, project.sf)
        return
    rt = await manager.ensure(run_id, project)
    if rt is None:
        await bus.publish(run_id, "error", {"message": "Run is not active", "kind": "client"}, project.sf)
        return
    if kind == "control":
        action = msg.get("action")
        if action in ("pause", "resume", "step", "stop"):
            getattr(rt, action)()
    elif kind in ("approve", "reject"):
        rt.resolve_approval(str(msg.get("approval_id", "")), kind == "approve", str(msg.get("reason", ""))[:1000],
                            "always" if msg.get("scope") == "always" else "once")


@router.websocket("/ws/w/{workspace_id}/chat/{session_id}")
async def chat_socket(ws: WebSocket, workspace_id: str, session_id: str) -> None:
    await ws.accept()
    user, ctx = await _auth(ws, workspace_id)
    if user is None or ctx is None:
        await ws.close(code=4401 if user is None else 4404)
        return
    async with ctx.sf() as db:
        s = await db.get(ChatSession, session_id)
        company = await db.get(Company, s.company_id) if s else None
        if s is None or company is None or company.user_id != user.id:
            await ws.close(code=4404)
            return
    conn = ChatConnection(ws, session_id, user.id, ctx.sf)
    try:
        while True:
            try:
                msg = await asyncio.wait_for(ws.receive_json(), timeout=25)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping", "data": {}})
                continue
            await conn.handle(msg)
    except (WebSocketDisconnect, RuntimeError):
        if conn.task and not conn.task.done():
            conn.task.cancel()
