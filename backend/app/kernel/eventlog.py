"""Run event log: an append-only persisted log with group commit, plus in-memory fan-out to live subscribers.

Every event except the live-only topics (token and thinking streams) is persisted with a monotonic id (``seq``) so clients
can reconnect and replay from their last seen id, and the timeline can be scrubbed after the run.

Writes are grouped: events published while a write is in flight join the next batch, and a batch is one transaction.
``publish`` returns once its event is committed and delivered, so callers see the same ordering and durability as with one
commit per event. Nothing is dropped without a trace: a subscriber whose queue is full is flagged ``lagged`` (it must
re-read the log from its last ``seq``), and dropped live-only events are counted in ``stats()``.
"""
from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.foundation.logging import get_logger
from app.sdk.topics import EPHEMERAL_TOPICS
from app.storage.models import RunEvent
from app.storage.repositories import RunEventRepository
from app.storage.session import SessionFactory

log = get_logger("eventlog")

EPHEMERAL = frozenset(t.value for t in EPHEMERAL_TOPICS)  # live-only; the finished thought is persisted as "thought"
MAX_BATCH = 500
QUEUE_SIZE = 5000

Observer = Callable[[dict[str, Any]], Awaitable[None] | None]


class Subscription(asyncio.Queue):  # type: ignore[type-arg]
    """A live subscriber's queue. ``lagged`` is set when a persisted event could not be queued: re-read the log from the last
    ``seq`` you handled, then call ``take_lag()``."""

    def __init__(self, maxsize: int = QUEUE_SIZE) -> None:
        super().__init__(maxsize)
        self.lagged = False
        self.dropped_live = 0

    def take_lag(self) -> bool:
        lagged, self.lagged = self.lagged, False
        return lagged


@dataclass
class _Pending:
    event: dict[str, Any]
    future: asyncio.Future[None]


@dataclass
class _Outbox:
    sf: SessionFactory
    items: list[_Pending] = field(default_factory=list)
    task: asyncio.Task[None] | None = None
    loop: asyncio.AbstractEventLoop | None = None


class EventLog:
    def __init__(self, *, queue_size: int = QUEUE_SIZE, max_batch: int = MAX_BATCH) -> None:
        self._subs: dict[str, set[Subscription]] = {}
        self._observers: list[tuple[Observer, frozenset[str] | None]] = []
        self._observer_tasks: set[asyncio.Task[Any]] = set()
        self._outboxes: dict[int, _Outbox] = {}
        self._queue_size = queue_size
        self._max_batch = max_batch
        self._stats = {"published": 0, "persisted": 0, "batches": 0, "largest_batch": 0, "dropped_live": 0, "lagged": 0, "write_errors": 0}

    # ------------------------------------------------------------------ subscribers
    def subscribe(self, run_id: str) -> Subscription:
        q = Subscription(self._queue_size)
        self._subs.setdefault(run_id, set()).add(q)
        return q

    def unsubscribe(self, run_id: str, q: Subscription) -> None:
        subs = self._subs.get(run_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                del self._subs[run_id]

    def observe(self, handler: Observer, topics: frozenset[str] | None = None) -> Callable[[], None]:
        """Call ``handler(event)`` for every delivered event (of ``topics`` when given). Errors in a handler are logged."""
        entry = (handler, topics)
        self._observers.append(entry)

        def cancel() -> None:
            if entry in self._observers:
                self._observers.remove(entry)

        return cancel

    def relay(self, event: dict[str, Any]) -> None:
        """Deliver an event whose row was already committed by someone else (the runtime store). Replay uses its ``seq``."""
        self._fanout(event)

    # ------------------------------------------------------------------ publishing
    async def publish(self, run_id: str, type_: str, data: dict[str, Any], sf: SessionFactory) -> dict[str, Any]:
        event: dict[str, Any] = {"type": type_, "run_id": run_id, "data": data, "ts": datetime.now(timezone.utc).isoformat()}
        self._stats["published"] += 1
        if type_ in EPHEMERAL:
            self._fanout(event)
            return event
        loop = asyncio.get_running_loop()
        outbox = self._outboxes.get(id(sf))
        if outbox is None or outbox.sf is not sf:
            outbox = self._outboxes[id(sf)] = _Outbox(sf)
        pending = _Pending(event, loop.create_future())
        outbox.items.append(pending)
        if outbox.task is None or outbox.task.done() or outbox.loop is not loop:
            outbox.loop = loop
            outbox.task = loop.create_task(self._drain(outbox), name="eventlog-drain")
        await pending.future
        return event

    async def _drain(self, outbox: _Outbox) -> None:
        while outbox.items:
            batch = outbox.items[: self._max_batch]
            del outbox.items[: len(batch)]
            rows = [RunEvent(run_id=p.event["run_id"], type=p.event["type"], payload_json=p.event["data"]) for p in batch]
            try:
                async with outbox.sf() as db:
                    repo = RunEventRepository(db)
                    for row in rows:
                        repo.add(row)
                        await db.flush()  # one statement per event keeps ids in publish order; the commit is shared
                    await db.commit()
            except Exception as exc:  # noqa: BLE001 - every waiting publisher gets the error, the writer keeps running
                self._stats["write_errors"] += 1
                log.error("event_write_failed", error=str(exc)[:300], events=len(batch))
                for p in batch:
                    if not p.future.done():
                        p.future.set_exception(exc)
                continue
            self._stats["batches"] += 1
            self._stats["persisted"] += len(batch)
            self._stats["largest_batch"] = max(self._stats["largest_batch"], len(batch))
            for p, row in zip(batch, rows):
                p.event["seq"] = row.id
                self._fanout(p.event)
                if not p.future.done():
                    p.future.set_result(None)
        outbox.task = None

    # ------------------------------------------------------------------ delivery
    def _fanout(self, event: dict[str, Any]) -> None:
        persisted = event.get("seq") is not None
        for q in list(self._subs.get(event["run_id"], ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                if persisted:
                    if not q.lagged:
                        self._stats["lagged"] += 1
                    q.lagged = True  # the subscriber re-reads the log from its last seq
                else:
                    q.dropped_live += 1
                    self._stats["dropped_live"] += 1
        for handler, topics in list(self._observers):
            if topics is None or event["type"] in topics:
                self._call_observer(handler, event)

    def _call_observer(self, handler: Observer, event: dict[str, Any]) -> None:
        try:
            result = handler(event)
            if inspect.isawaitable(result):
                task = asyncio.ensure_future(self._guard(result))
                self._observer_tasks.add(task)
                task.add_done_callback(self._observer_tasks.discard)
        except Exception as exc:  # noqa: BLE001 - an observer must never break a run
            log.warning("observer_failed", error=str(exc)[:200])

    @staticmethod
    async def _guard(awaitable: Awaitable[Any]) -> None:
        try:
            await awaitable
        except Exception as exc:  # noqa: BLE001
            log.warning("observer_failed", error=str(exc)[:200])

    # ------------------------------------------------------------------ introspection
    def stats(self) -> dict[str, int]:
        return {**self._stats, "subscribers": sum(len(s) for s in self._subs.values())}

    async def flush(self) -> None:
        """Wait until every queued event is committed (used at shutdown)."""
        tasks = [o.task for o in self._outboxes.values() if o.task is not None and not o.task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
