"""Run lifecycle and the turn loop skeleton.

RunManager owns the live runtimes. It starts a run, restores a persisted one, wakes a committed request queue and shuts
everything down. It builds runtimes and reads run rows through two functions that the orchestrator passes in, so this module
imports nothing above core.

run_turn_loop is the scheduler one run executes: check the limits, wait at the gate, pick the next agent, run its turn (or a
concurrent batch), persist, then finish, pause or idle. The orchestration steps (who may run, what an idle run does, how a
finished run is reported) are methods on the runtime that implements LoopHost.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Protocol

from app.core.logging import get_logger

if TYPE_CHECKING:
    from app.db.session import SessionFactory

log = get_logger("orchestrator")

ACTIVE_STATES = {"queued", "running", "paused", "awaiting_user"}


class StopRun(Exception):
    pass


@dataclass
class ProjectRef:
    """Where a run lives: the project directory and its .octopus database."""

    workspace_id: str
    root: Path
    sf: SessionFactory


class LiveRun(Protocol):
    """What RunManager reads and changes on a runtime it owns."""

    run_id: str
    root: Path
    task: asyncio.Task[None] | None
    finalized: bool
    stop_requested: bool
    recovery_required: bool
    paused: bool
    mailbox: dict[str, Any]
    observations: dict[str, Any]
    wake: asyncio.Event
    runtime_store: Any

    async def restore(self, run: Any) -> None: ...

    async def save(self) -> None: ...

    async def steer_execution(self) -> None: ...

    async def set_run_status(self, status: str, reason: str = "") -> None: ...

    async def main(self, fresh: bool = True) -> None: ...


RunFactory = Callable[[Any, str, ProjectRef], LiveRun]
RunLoader = Callable[[str, ProjectRef], Awaitable["tuple[Any, str] | None"]]


class RunManager:
    """Owns live runtimes. Runs are keyed by id (UUIDs are globally unique across projects).

    ``create(run, user_id, project)`` builds a runtime. ``load(run_id, project)`` returns (run row, owner user id) or None.
    """

    def __init__(self, *, create: RunFactory, load: RunLoader) -> None:
        self.runtimes: dict[str, LiveRun] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self._create = create
        self._load_run = load

    async def _load(self, run_id: str, project: ProjectRef) -> tuple[Any, str] | None:
        return await self._load_run(run_id, project)

    async def start(self, run_id: str, project: ProjectRef) -> LiveRun:
        async with self.locks.setdefault(run_id, asyncio.Lock()):
            existing = self.runtimes.get(run_id)
            if existing:
                return existing
            return await self._start(run_id, project)

    async def _start(self, run_id: str, project: ProjectRef) -> LiveRun:
        loaded = await self._load(run_id, project)
        assert loaded, "run not found"
        run, user_id = loaded
        rt = self._create(run, user_id, project)
        self.runtimes[run_id] = rt
        rt.task = asyncio.create_task(rt.main(fresh=True), name=f"run-{run_id}")
        return rt

    async def ensure(self, run_id: str, project: ProjectRef) -> LiveRun | None:
        """Return the live runtime, restoring a persisted (paused / interrupted) run if needed."""
        async with self.locks.setdefault(run_id, asyncio.Lock()):
            return await self._ensure(run_id, project)

    async def _ensure(self, run_id: str, project: ProjectRef) -> LiveRun | None:
        if run_id in self.runtimes:
            return self.runtimes[run_id]
        loaded = await self._load(run_id, project)
        if not loaded:
            return None
        run, user_id = loaded
        if run.status not in ACTIVE_STATES:
            return None
        rt = self._create(run, user_id, project)
        await rt.restore(run)
        rt.recovery_required = await rt.runtime_store.recover() or rt.recovery_required
        rt.paused = True
        if rt.recovery_required:
            rt.mailbox.clear()
            rt.observations.clear()
            await rt.save()
        self.runtimes[run_id] = rt
        rt.task = asyncio.create_task(rt.main(fresh=run.started_at is None), name=f"run-{run_id}")
        return rt

    async def notify_requests(self, run_id: str, project: ProjectRef, *, steer: bool = False) -> LiveRun | None:
        """Wake a committed durable queue. Never replay ambiguous interrupted work."""
        async with self.locks.setdefault(run_id, asyncio.Lock()):
            rt = self.runtimes.get(run_id)
            if rt and rt.task and not rt.task.done() and not rt.finalized:
                if steer:
                    await rt.steer_execution()
                rt.wake.set()
                return rt
            loaded = await self._load(run_id, project)
            if not loaded:
                return None
            run, user_id = loaded
            rt = self._create(run, user_id, project)
            await rt.restore(run)
            rt.recovery_required = await rt.runtime_store.recover() or rt.recovery_required
            if rt.recovery_required or run.status not in ACTIVE_STATES:
                rt.mailbox.clear()
                rt.observations.clear()
            rt.finalized = False
            rt.stop_requested = False
            rt.paused = rt.recovery_required
            self.runtimes[run_id] = rt
            if steer:
                await rt.steer_execution()
            await rt.set_run_status("paused" if rt.recovery_required else "running")
            await rt.save()
            rt.task = asyncio.create_task(rt.main(fresh=False), name=f"run-{run_id}")
            return rt

    def get(self, run_id: str) -> LiveRun | None:
        return self.runtimes.get(run_id)

    def forget(self, run_id: str) -> None:
        self.runtimes.pop(run_id, None)

    def active_for(self, root: Path) -> list[LiveRun]:
        return [rt for rt in self.runtimes.values() if rt.root == root.resolve() or rt.root == root]

    async def shutdown(self) -> None:
        tasks = [rt.task for rt in self.runtimes.values() if rt.task and not rt.task.done()]
        for rt in list(self.runtimes.values()):
            rt.stop_requested = True
            if rt.task and not rt.task.done():
                rt.task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=5)


class LoopHost(Protocol):
    """What one run's turn loop calls on its runtime. The runtime implements the scheduling and orchestration steps."""

    run_id: str
    recovery_required: bool
    paused: bool
    active_seconds: float
    turn_t0: float | None
    finished_summary: str | None

    def loop_has_active_agents(self) -> bool: ...

    async def loop_mark_started(self) -> None: ...

    async def begin_run(self, fresh: bool) -> None: ...

    async def loop_housekeeping(self) -> None: ...

    def limit_reason(self) -> str | None: ...

    async def emit(self, type_: str, data: dict[str, Any]) -> None: ...

    async def finalize(self, status: str, reason: str) -> None: ...

    async def gate(self) -> None: ...

    def next_runnable(self) -> str | None: ...

    async def loop_idle_step(self) -> bool: ...

    def loop_pick_batch(self, aid: str) -> list[str]: ...

    async def turn(self, aid: str) -> None: ...

    async def save(self) -> None: ...

    async def usage_event(self) -> None: ...

    async def apply_queued_request(self) -> bool: ...

    def loop_completion_reason(self) -> str: ...

    async def loop_after_turn(self) -> None: ...

    async def check_stall(self) -> None: ...


async def run_turn_loop(host: LoopHost, *, fresh: bool) -> None:
    """Drive one run until it finalizes: completed, incomplete, failed (limits, setup errors) or cancelled (kill switch)."""
    try:
        if not host.loop_has_active_agents():
            await host.finalize("failed", "The company has no active agents")
            return
        await host.loop_mark_started()
        await host.begin_run(fresh)
        while True:
            if host.recovery_required:
                host.paused = True
            await host.loop_housekeeping()
            reason = host.limit_reason()
            if reason:
                await host.emit("error", {"message": reason, "kind": "limit"})
                await host.finalize("failed", reason)
                return
            await host.gate()
            aid = host.next_runnable()
            if aid is None:
                if not await host.loop_idle_step():
                    return
                continue
            t0 = host.turn_t0 = time.monotonic()
            try:
                batch = host.loop_pick_batch(aid)
                if len(batch) == 1:
                    await host.turn(aid)
                else:
                    outcomes = await asyncio.gather(*(host.turn(worker) for worker in batch), return_exceptions=True)
                    for outcome in outcomes:
                        if isinstance(outcome, BaseException):
                            raise outcome
            finally:
                host.turn_t0 = None
                host.active_seconds += time.monotonic() - t0
            await host.save()
            await host.usage_event()
            if host.finished_summary is not None:
                if await host.apply_queued_request():
                    continue
                await host.finalize("completed", host.loop_completion_reason())
                return
            await host.loop_after_turn()
            await host.check_stall()
    except (StopRun, asyncio.CancelledError):
        await asyncio.shield(host.finalize("cancelled", "Stopped by user (kill switch)"))
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("run_failed", run_id=host.run_id)
        await asyncio.shield(host.finalize("failed", f"{type(exc).__name__}: {exc}"))
