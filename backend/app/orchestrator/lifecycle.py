"""Run lifecycle: follow-up requests, goal attachments, roster entry points, role loading and finalization."""

from __future__ import annotations

from collections import Counter
from sqlalchemy import update
from typing import TYPE_CHECKING, Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.policy import FOLLOWUP_BUDGET_CEILING
from app.db.base import utcnow
from app.db.session import registry_factory
from app.models import Run
from app.schemas import RunBudget
from app.services import skills as SK

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime

log = get_logger("orchestrator")


async def continue_with(rt: RunRuntime, content: str, to_agent_id: str | None, *, message_meta: dict[str, Any] | None = None) -> None:
    """Re-open a finished run with a follow-up. Same run, same history, files and task board; budgets get fresh headroom."""
    rt.followups.append(content)  # bounded by the API (20k); shown with a visible cut on the Blackboard
    rt.finalized = False
    rt.finished_summary = None
    rt.loop_escalated = rt.stall_escalated = False
    rt.loop.acknowledge(hot=False)
    rt.stall_ack = rt.turn_no
    rt.paused = False
    rt.stop_requested = False
    rt.awaiting = None
    rt.agent_turns = Counter()  # per-agent autonomy limits apply per request
    # Each follow-up gets fresh headroom of one base budget, but never beyond FOLLOWUP_BUDGET_CEILING x the base over
    # the run's lifetime: N follow-ups must not mean N x the spend the user agreed to.
    base = RunBudget(**(rt.budget_base or rt.budget.model_dump()))
    ceil = FOLLOWUP_BUDGET_CEILING
    rt.budget.max_turns = min(2000, rt.turn_no + base.max_turns, base.max_turns * ceil)
    rt.budget.max_tokens = min(rt.tokens + base.max_tokens, base.max_tokens * ceil)
    if base.max_cost_usd > 0:
        rt.budget.max_cost_usd = round(min(rt.cost + base.max_cost_usd, base.max_cost_usd * ceil), 6)
    rt.budget.timeout_s = min(86400, int(rt.active_seconds) + base.timeout_s, base.timeout_s * ceil)
    async with rt.db() as db:
        await db.execute(update(Run).where(Run.id == rt.run_id).values(ended_at=None, halt_reason="", budget_json=rt.budget.model_dump()))
        await db.commit()
    rt.self_turns = Counter()
    rt.nudged = {}
    rt.mark_progress()
    await rt.set_run_status("running")
    await rt.emit("run_continued", {"content": content, "to_agent_id": to_agent_id, "followup": len(rt.followups)})
    if to_agent_id in rt.agents:
        targets = [to_agent_id]
    else:  # "entry agent": the entry agent plus everyone who still owns an open task (they'd never be woken otherwise)
        from app.core.contracts import route_target
        targets = [route_target(content, [a.to_dict() for a in rt.agents.values()], rt.lead_agent_id)]
    for t in targets:
        if t != rt.lead_agent_id:
            await rt.link_task(rt.lead_agent_id, t, None, content)
        mine = [x for x in rt.open_tasks() if x["assignee"] == t]
        owned = ("\n\nYou still own these open tasks:\n" + "\n".join(f"- {rt.task_line(x)}" for x in mine)
                 + "\nContinue them, or update the task board.") if mine else ""
        await rt.post_message(sender="user", from_id=None, to_id=t, type_="task", meta={"followup": True, **(message_meta or {})},
                                content=f"Follow-up from the user: {content}\n\nThe previous work is in the project (see Workspace files). "
                                        f"Change what's needed and report back; don't start over.{owned}")
    rt.wake.set()


def entry_agents(rt: RunRuntime) -> list[str]:
    if hasattr(rt, "lead_agent_id"):
        return [rt.lead_agent_id]
    active = [aid for aid, a in rt.agents.items() if a.active]
    entries = [aid for aid in active if rt.agents[aid].is_entry]
    if entries:
        return entries
    targets = {e.target for e in rt.edges} | {e.source for e in rt.edges if e.bidirectional}
    roots = [aid for aid in active if aid not in targets]
    return roots[:1] or active[:1]


def goal_images(rt: RunRuntime) -> list[dict[str, str]]:
    """Images the user attached to the goal, as model input. Every agent sees them (the builder needs the mock-up as
        much as the CEO does); they sit in the first user message, so they stay in the prompt cache across a tool loop."""
    if rt._goal_images is None:
        from app.services.run_attachments import load_images

        try:
            rt._goal_images = load_images(rt.root, rt.run_id, rt.attachments)
        except OSError:
            rt._goal_images = []
    return rt._goal_images


def attach_followup(rt: RunRuntime, content: str, files: list[dict[str, str]], *, stored: bool = False) -> tuple[str, dict[str, Any]]:
    meta: dict[str, Any] = {"display_content": content}
    if not files:
        return content, meta
    from app.services.run_attachments import MAX_IMAGES, store

    items = files if stored else store(rt.root, rt.run_id, files, unique=True)
    images = [item for item in [*rt.attachments, *items] if item.get("kind") == "image"][-MAX_IMAGES:]
    rt.attachments = [item for item in [*rt.attachments, *items] if item.get("kind") != "image"][-20:] + images
    rt._goal_images = None
    for item in items:
        if item.get("kind") == "image":
            content += f"\n\nAttached image: {item['filename']} (shown to the agents)."
        else:
            content += f"\n\n--- Attached file: {item['filename']} ---\n{item.get('text', '')}"
    meta["images"] = [{"filename": item["filename"], "name": item["name"], "mime": item["mime"]} for item in items if item.get("kind") == "image"]
    meta["files"] = [item["filename"] for item in items if item.get("kind") != "image"]
    return content, meta


def preview_url(rt: RunRuntime) -> str:
    """Where the agents' browser can open this project (served by Octopus, sandboxed)."""
    return f"{get_settings().public_url.rstrip('/')}/api/v1/w/{rt.project.workspace_id}/preview/"


async def load_roles(rt: RunRuntime) -> None:
    """The run owner's role library (built-in roles + their edits + their own roles): linked agents' prompts come from it."""
    from app.services.roles import effective_roles

    try:
        async with registry_factory()() as rdb:
            rt.roles = await effective_roles(rdb, rt.user_id)
            rt.skills = await SK.effective_skills(rdb, rt.user_id, rt.root)
    except Exception as exc:  # noqa: BLE001 - built-in roles and skills still work
        log.warning("roles_not_loaded", error=str(exc)[:200])


async def finalize(rt: RunRuntime, status: str, reason: str) -> None:
    from app.orchestrator.runtime_store import mutation_lock
    async with mutation_lock(rt.run_id):
        await rt._finalize(status, reason)


async def _finalize(rt: RunRuntime, status: str, reason: str) -> None:
    if rt.finalized:
        return
    async with rt.db() as db:
        current = await db.get(Run, rt.run_id)
        if current and int((current.state_json or {}).get("plan_revision", 1)) > rt.plan_revision:
            return  # A committed steer owns the next scheduler iteration.
    if rt._last_manifest is not None:
        await rt.execution.refresh_execution_evidence()
    blockers = rt.execution.engineering_blockers()
    from app.orchestrator.quality import assess_completion
    status, reason = assess_completion(
        status, reason, workflow=rt.wf, open_tasks=rt.open_tasks(),
        broken_files=rt.broken_files, unverified=rt.unverified,
        require_verification=rt.budget.verify_before_finish,
    )
    if status in ("completed", "incomplete") and blockers:
        status, reason = "incomplete", "; ".join(filter(None, (reason, *blockers)))
    rt.finalized = True
    for aid in rt.agents:
        final = "done" if (aid in rt.done_agents or (status == "completed" and rt.agent_turns[aid])) else "idle"
        await rt.set_agent_status(aid, final)
    summary = rt.finished_summary or reason
    async with rt.db() as db:
        await db.execute(update(Run).where(Run.id == rt.run_id).values(
            status=status, halt_reason=reason[:200], summary=summary, ended_at=utcnow(),
            tokens_used=rt.tokens, cost_usd=round(rt.cost, 6), turns=rt.turn_no, state_json=rt.state_dict()))
        await db.commit()
    from app.services.browser import browser
    from app.services.report import build_report  # local import avoids a cycle

    await browser.close_run(rt.run_id)

    try:
        report = await build_report(rt.run_id, rt.sf)
        async with rt.db() as db:
            await db.execute(update(Run).where(Run.id == rt.run_id).values(report_md=report))
            await db.commit()
    except Exception:  # pragma: no cover
        log.exception("report_failed", run_id=rt.run_id)
    rt.run_status = status
    await rt.usage_event()
    await rt.emit("run_status", {"status": status, "reason": reason, "summary": summary, "final": True})
    from app.orchestrator.engine import manager  # engine imports this module; import at call time
    if manager.get(rt.run_id) is rt:
        manager.forget(rt.run_id)
