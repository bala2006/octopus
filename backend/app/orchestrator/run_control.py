"""Run loop callbacks: start-up, scheduling, pause, resume, stop, the stall watchdog and budget limits."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

from app.core.policy import BudgetUsage
from app.core.run_manager import StopRun, run_turn_loop
from app.db.base import utcnow
from app.db.repositories import RunRepository
from app.models import Run
from app.orchestrator.context import clip

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


# How many turns in a row an agent may take only because of its own tool results / notices (no new message). Reading a
# file and acting on it needs one; an agent that keeps re-reading without producing anything is spinning.
MAX_SELF_TURNS = 3


def next_runnable(rt: RunRuntime, exclude: set[str] | None = None) -> str | None:
    """FIFO over queued messages and activating observations. An agent that has already taken MAX_SELF_TURNS turns in a
        row on its own observations (no new message, no progress) is only woken by a message again."""
    best: tuple[int, str] | None = None
    for aid in rt.agents:
        if not rt.agents[aid].active or aid in (exclude or set()) or aid in rt.waiting_peers:
            continue
        owned = [task for task in rt.open_tasks() if task.get("assignee") == aid]
        if aid != rt.lead_agent_id and owned and not any(rt.task_ready(task) for task in owned):
            # Answers and decisions may still resolve a waiting dependency.
            messages = {message["id"]: message for message in rt.history}
            if not any(messages.get(mid, {}).get("type") in ("answer", "decision", "review_result")
                       for _, mid in rt.mailbox.get(aid, [])):
                continue
        seqs = [s for s, _ in rt.mailbox.get(aid, [])]
        if rt.self_turns[aid] < MAX_SELF_TURNS:
            seqs += [s for s, o in rt.observations.get(aid, []) if o.get("activate")]
        if seqs:
            s = min(seqs)
            if best is None or s < best[0]:
                best = (s, aid)
    return best[1] if best else None


def active_now(rt: RunRuntime) -> float:
    """Active time including the turn in progress: one long turn (a 40-round tool loop with nested delegations) used to
        run far past the time limit, because the limit only saw the time of finished turns."""
    return rt.active_seconds + (time.monotonic() - rt.turn_t0 if rt.turn_t0 is not None else 0.0)


def limit_reason(rt: RunRuntime, *, turns: bool = True) -> str | None:
    """``turns=False`` inside a turn's tool loop: the turn is already counted, only spend and time can run out."""
    return rt.policy.budget_reason(BudgetUsage(turns=rt.turn_no, tokens=rt.tokens, cost=rt.cost,
                                                 active_seconds=rt.active_now(), has_followups=bool(rt.followups)), turns=turns)


async def check_stall(rt: RunRuntime) -> None:
    """Progress watchdog: no file changed and no task moved for ``stall_turns`` turns → pause and show the human the board."""
    n = rt.budget.stall_turns
    if not n or rt.stall_escalated or rt.turn_no - max(rt.progress_turn, rt.stall_ack) < n:
        return
    rt.stall_escalated = True
    rt.paused = True
    open_ = rt.open_tasks()
    board = "; ".join(f"{t['key']} {t['status']}" for t in open_[:8]) or "no open tasks"
    await rt.emit("error", {"kind": "stall", "message": (
        f"No progress for {rt.turn_no - rt.progress_turn} turns: no file changed and no task moved since turn {rt.progress_turn} "
        f"(board: {board}). Run paused; interject to steer, then resume, or stop it.")})


async def gate(rt: RunRuntime) -> None:
    while True:
        rt.wake.clear()
        if rt.stop_requested:
            raise StopRun()
        if rt.recovery_required:
            await rt.set_run_status("paused", "Recovery review required before another invocation")
        elif rt.awaiting:
            await rt.set_run_status("awaiting_user")
        elif rt.paused:
            await rt.set_run_status("paused")
        elif rt.mode == "step" and rt.step_credits <= 0:
            await rt.set_run_status("paused", "Step mode: press Next turn")
        else:
            break
        await rt.wake.wait()
    if rt.mode == "step":
        rt.step_credits -= 1
    await rt.set_run_status("running")


def pause(rt: RunRuntime) -> None:
    rt.paused = True
    rt.wake.set()


def resume(rt: RunRuntime) -> None:
    rt.paused = False
    if rt.loop_escalated:  # keep the evidence; the next repeat pauses again instead of needing max_strikes more
        rt.loop.acknowledge(hot=True)
    rt.loop_escalated = False
    if rt.stall_escalated:
        rt.stall_ack = rt.turn_no
    rt.stall_escalated = False
    if rt.mode == "step":
        rt.step_credits = max(rt.step_credits, 1)
    rt.wake.set()


def step(rt: RunRuntime) -> None:
    rt.paused = False
    rt.step_credits += 1
    rt.wake.set()


def stop(rt: RunRuntime) -> None:
    rt.stop_requested = True
    rt.wake.set()
    rt.policy.cancel_pending()
    if rt.task and not rt.task.done():
        rt.task.cancel()


async def bootstrap(rt: RunRuntime) -> None:
    content = rt.goal
    images = [a for a in rt.attachments if a.get("kind") == "image"]
    for att in rt.attachments:
        if att.get("kind") != "image":
            content += f"\n\n--- Attached file: {att.get('filename', 'file')} ---\n" + clip(str(att.get("text", "")), 30000)
    if images:
        content += "\n\n--- Attached image(s), shown to every agent as images: " + ", ".join(str(a.get("filename")) for a in images) + " ---"
    meta: dict[str, Any] = {"goal": True, "display_content": rt.goal,
                            "files": [item["filename"] for item in rt.attachments if item.get("kind") != "image"]}
    if rt.wf_enabled_for_run():
        rt.wf_init()
        content += rt.wf_intake_note()
        await rt.wf_emit()
    if images:
        meta["images"] = [{"filename": a.get("filename"), "name": a.get("name"), "mime": a.get("mime")} for a in images]
    rt.goal_content = content.split("\n\n--- How this company works ---")[0]
    for aid in [getattr(rt, "initial_target", None) or rt.lead_agent_id]:
        if aid != rt.lead_agent_id:
            meta["task_id"] = await rt.link_task(rt.lead_agent_id, aid, None, rt.goal)
        await rt.post_message(sender="user", from_id=None, to_id=aid, type_="task", content=content, meta=meta)


async def main(rt: RunRuntime, fresh: bool = True) -> None:
    await run_turn_loop(rt, fresh=fresh)


def loop_has_active_agents(rt: RunRuntime) -> bool:
    return any(a.active for a in rt.agents.values())


async def loop_mark_started(rt: RunRuntime) -> None:
    async with rt.db() as db:
        await RunRepository(db).update(rt.run_id, Run.started_at.is_(None), started_at=utcnow())
        await db.commit()


async def begin_run(rt: RunRuntime, fresh: bool) -> None:
    if fresh:
        await rt.set_run_status("running")
        await rt._load_memory()
    await rt.load_mcp()
    await rt.execution.prepare_execution()
    if fresh:
        await rt.bootstrap()


async def loop_housekeeping(rt: RunRuntime) -> None:
    """Before each pick: expire peer consultations, end waits nobody serves any more, apply a queued user request."""
    for consultation in await rt.runtime_store.expire_consultations():
        sender = consultation["sender"]
        rt.waiting_peers.pop(sender, None)
        rt.notice(sender, "Peer consultation timed out. Escalate to the lead with what is still unknown.", activate=True)
    if rt.waiting_peers:
        consultations = (await rt.runtime_store.summary())["consultations"]
        waiting = {c["sender"]: c["recipient"] for c in consultations if c["state"] == "waiting"}
        for sender in set(rt.waiting_peers) - waiting.keys():
            rt.waiting_peers.pop(sender, None)
            rt.notice(sender, "Peer wait ended; inspect the result or escalate unresolved work.", activate=True)
    if rt.awaiting and not rt.recovery_required:
        await rt.execution.apply_queued_request()


async def loop_idle_step(rt: RunRuntime) -> bool:
    """Nothing is runnable. True: keep looping. False: the run was finalized and the loop ends."""
    if await rt.execution.apply_queued_request():
        return True
    if rt.awaiting:
        return True
    if rt.waiting_peers:
        rt.wake.clear()
        try:
            await asyncio.wait_for(rt.wake.wait(), timeout=1)
        except asyncio.TimeoutError:
            pass
        return True
    if rt.wf_active() and await rt.nudge_workflow():
        return True
    if await rt.nudge_open_tasks():
        return True
    open_ = rt.open_tasks()
    acceptance_key = f"{rt.plan_revision}:{rt.current_request_id or 'initial'}"
    if not open_ and rt.progress_turn > 0 and acceptance_key not in rt.acceptance_nudges:
        rt.acceptance_nudges.append(acceptance_key)
        await rt.post_message(sender="system", from_id=None, to_id=rt.lead_agent_id, type_="task",
            content="Work is quiescent. Review the integrated outcome against the user's request, then call finish with what is done and any missing verification. A successful tool call is not final acceptance.",
            meta={"acceptance_nudge": True})
        return True
    if open_:  # never report success while the board says work is unfinished
        await rt.finalize("incomplete", f"Stalled: {len(open_)} open task(s) and no agent can make progress ("
                            + "; ".join(f"{t['key']} {t['status']}" for t in open_[:6]) + ")")
    else:
        await rt.finalize("incomplete", "No accountable lead acceptance: no agent has pending work and no final report was produced")
    return False


def loop_pick_batch(rt: RunRuntime, aid: str) -> list[str]:
    # Only independently queued specialists overlap. The lead and ordered workflow phases stay serial; writes use private stages.
    batch = [aid]
    if aid != rt.lead_agent_id and not rt.wf_active():
        for _ in range(rt.budget.max_concurrency - 1):
            other = rt.next_runnable(exclude=set(batch) | {rt.lead_agent_id})
            if other is None:
                break
            batch.append(other)
    return batch


def loop_completion_reason(rt: RunRuntime) -> str:
    open_ = rt.open_tasks()
    return f"Finished with {len(open_)} open task(s): " + "; ".join(f"{t['key']} {t['status']}" for t in open_[:6]) if open_ else ""


async def loop_apply_queued_request(rt: RunRuntime) -> bool:
    return await rt.execution.apply_queued_request()


async def loop_after_turn(rt: RunRuntime) -> None:
    """Loop detector: the first repeat pauses the run for a human; the detector keeps the evidence."""
    if rt.loop.escalate() and not rt.loop_escalated:
        rt.loop_escalated = True
        rt.paused = True
        await rt.emit("error", {"message": f"Loop detected: agents keep repeating themselves ({rt.loop.last_reason or 'repeated messages'}). "
                                             "Run paused for human review; interject to steer, then resume.", "kind": "loop"})
