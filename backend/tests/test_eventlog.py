"""The run event log: ordered group commits, no silent drops, live-only topics and observers."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.kernel.eventlog import EventLog, Subscription
from app.storage.base import ProjectBase
from app.storage.models import Company, Run, RunEvent
from app.storage.session import make_engine


@pytest_asyncio.fixture
async def sf(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'events.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(ProjectBase.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db, db.begin():  # run_events reference their run
        db.add(Company(id="co", user_id="owner", name="Mine"))
        await db.flush()
        db.add_all(Run(id=run_id, company_id="co", goal="Test", snapshot_json={}, state_json={}) for run_id in ("r1", "a", "b", "c"))
    yield factory
    await engine.dispose()


async def stored(sf, run_id: str) -> list[RunEvent]:
    async with sf() as db:
        return list((await db.execute(select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.id))).scalars().all())


async def test_published_events_are_committed_in_order_with_a_sequence_number(sf) -> None:
    log = EventLog()
    queue = log.subscribe("r1")
    events = [await log.publish("r1", "turn_started", {"n": n}, sf) for n in range(5)]
    seqs = [e["seq"] for e in events]
    assert seqs == sorted(seqs) and len(set(seqs)) == 5
    assert [row.payload_json["n"] for row in await stored(sf, "r1")] == [0, 1, 2, 3, 4]
    assert [queue.get_nowait()["seq"] for _ in range(5)] == seqs  # delivered after the commit, in the same order


async def test_events_published_together_share_a_transaction(sf) -> None:
    log = EventLog()
    runs = ("a", "b", "c")
    await asyncio.gather(*(log.publish(runs[n % 3], "message_created", {"n": n}, sf) for n in range(150)))
    stats = log.stats()
    assert stats["persisted"] == 150
    assert stats["batches"] < 150 and stats["largest_batch"] > 1  # one commit per event would be 150 batches
    for run_id in runs:  # each run keeps the order its events were published in
        numbers = [row.payload_json["n"] for row in await stored(sf, run_id)]
        assert numbers == sorted(numbers) and len(numbers) == 50


async def test_live_only_topics_are_delivered_but_never_stored(sf) -> None:
    log = EventLog()
    queue = log.subscribe("r1")
    event = await log.publish("r1", "token_stream", {"delta": "hi"}, sf)
    assert "seq" not in event and queue.get_nowait() is event
    assert await stored(sf, "r1") == []


async def test_a_slow_subscriber_is_flagged_instead_of_silently_losing_events(sf) -> None:
    log = EventLog(queue_size=2)
    slow = log.subscribe("r1")
    for n in range(5):
        await log.publish("r1", "turn_started", {"n": n}, sf)
    assert slow.qsize() == 2 and slow.lagged  # the reader must re-read the log from its last seq
    assert slow.take_lag() is True and slow.take_lag() is False
    assert log.stats()["lagged"] == 1
    assert len(await stored(sf, "r1")) == 5  # nothing was lost from the log itself


async def test_dropped_live_only_events_are_counted(sf) -> None:
    log = EventLog(queue_size=1)
    slow = log.subscribe("r1")
    for _ in range(4):
        await log.publish("r1", "thinking_stream", {"delta": "."}, sf)
    assert slow.dropped_live == 3 and log.stats()["dropped_live"] == 3 and not slow.lagged


async def test_a_failed_write_reaches_the_publisher_and_the_writer_keeps_working(sf) -> None:
    log = EventLog()

    @asynccontextmanager
    async def broken():
        raise RuntimeError("disk full")
        yield  # pragma: no cover

    with pytest.raises(RuntimeError, match="disk full"):
        await log.publish("r1", "turn_started", {}, broken)
    assert log.stats()["write_errors"] == 1
    event = await log.publish("r1", "turn_started", {"after": True}, sf)
    assert event["seq"] and len(await stored(sf, "r1")) == 1


async def test_relayed_events_keep_their_committed_sequence(sf) -> None:
    log = EventLog()
    queue = log.subscribe("r1")
    log.relay({"type": "task_updated", "run_id": "r1", "data": {}, "seq": 41})
    assert queue.get_nowait()["seq"] == 41


async def test_observers_see_delivered_events_and_cannot_break_publishing(sf) -> None:
    log = EventLog()
    seen: list[str] = []
    log.observe(lambda event: seen.append(event["type"]))
    log.observe(lambda event: (_ for _ in ()).throw(ValueError("observer bug")))
    only_errors: list[str] = []
    cancel = log.observe(lambda event: only_errors.append(event["type"]), frozenset({"error"}))
    await log.publish("r1", "turn_started", {}, sf)
    await log.publish("r1", "error", {"message": "x"}, sf)
    assert seen == ["turn_started", "error"] and only_errors == ["error"]
    cancel()
    await log.publish("r1", "error", {"message": "y"}, sf)
    assert only_errors == ["error"]


async def test_unsubscribe_removes_the_queue(sf) -> None:
    log = EventLog()
    queue = log.subscribe("r1")
    assert isinstance(queue, Subscription) and log.stats()["subscribers"] == 1
    log.unsubscribe("r1", queue)
    assert log.stats()["subscribers"] == 0
    await log.publish("r1", "turn_started", {}, sf)
    assert queue.empty()
