"""Run event bus: append-only persisted log + in-memory pub/sub for WebSocket fan-out.

Every event except ``token_stream`` is persisted with a monotonic id (``seq``) so clients can
reconnect and replay from their last seen id, and the timeline can be scrubbed after the run.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from app.db.session import SessionFactory
from app.models import RunEvent

EPHEMERAL = {"token_stream", "thinking_stream"}  # live-only; the finished thought is persisted as "thought"


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=5000)
        self._subs[run_id].add(q)
        return q

    def unsubscribe(self, run_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        self._subs[run_id].discard(q)

    async def publish(self, run_id: str, type_: str, data: dict[str, Any], sf: SessionFactory) -> dict[str, Any]:
        event: dict[str, Any] = {"type": type_, "run_id": run_id, "data": data,
                                 "ts": datetime.now(timezone.utc).isoformat()}
        if type_ not in EPHEMERAL:
            async with self._locks[run_id]:
                async with sf() as db:
                    row = RunEvent(run_id=run_id, type=type_, payload_json=data)
                    db.add(row)
                    await db.commit()
                    event["seq"] = row.id
        for q in list(self._subs.get(run_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass  # slow consumer; it can replay from the log on reconnect
        return event


bus = EventBus()
