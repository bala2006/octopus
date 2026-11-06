"""Run persistence and status: the state snapshot saved to the run row, restore after a restart, and usage accounting."""

from __future__ import annotations

from collections import Counter
from sqlalchemy import func, or_
from typing import TYPE_CHECKING, Any

from app.db.repositories import ArtifactRepository, MessageRepository, RunRepository, TaskRepository
from app.models import Run
from app.workflows.boardroom import DebateState
from app.workflows.protocols import LoopDetector
from app.workflows.review import ReviewState

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


# Delegation as a tool call: the delegated teammate's sub-turn runs inside the delegator's tool call. These context vars
# follow each asyncio task, so parallel delegations each see their own frame.
JOURNAL_MAX = 400


def state_dict(rt: RunRuntime) -> dict[str, Any]:
    return {
        **rt.execution.execution_state(),
        "attachments": rt.attachments,
        "observations": {k: [o for _, o in v] for k, v in rt.observations.items()},
        "status": rt.status, "done_agents": sorted(rt.done_agents),
        "agent_turns": dict(rt.agent_turns), "agent_tokens": dict(rt.agent_tokens), "edge_counts": dict(rt.edge_counts),
        "agent_cost": dict(rt.agent_cost), "usage_totals": dict(rt.usage_totals), "cost_totals": dict(rt.cost_totals),
        "llm_calls": rt.llm_calls,
        "debates": {k: v.to_dict() for k, v in rt.debates.items()},
        "reviews": {k: v.to_dict() for k, v in rt.reviews.items()},
        "loop": rt.loop.to_dict(), "task_counter": rt.task_counter,
        "decisions": rt.decisions, "user_notes": rt.user_notes, "followups": rt.followups, "agent_state": rt.agent_state,
        "active_seconds": round(rt.active_seconds, 2), "awaiting": rt.awaiting,
        "pending_approval": rt.pending_approval, "rejections": rt.rejections,
        "auto_approve": sorted(rt.policy.auto_approve), "activity": rt.activity,
        "budget_base": rt.budget_base,
        "self_turns": dict(rt.self_turns), "progress_turn": rt.progress_turn, "nudged": rt.nudged,
        "stall_ack": rt.stall_ack,
        "broken_files": rt.broken_files, "workflow": rt.wf,
        "unverified": rt.unverified,
        "journal": rt.journal[-JOURNAL_MAX:], "journal_n": rt.journal_n, "seen": rt.seen, "seen_turn": rt.seen_turn,
        "metrics": rt.efficiency(),
    }


async def save(rt: RunRuntime) -> None:
    values: dict[str, Any] = {"tokens_used": rt.tokens, "cost_usd": round(rt.cost, 8), "turns": rt.turn_no, "state_json": rt.state_dict()}
    if rt.snapshot_dirty:
        values["snapshot_json"] = rt.snapshot
        rt.snapshot_dirty = False
    async with rt.db() as db:
        await RunRepository(db).update(rt.run_id,
            or_(func.json_extract(Run.state_json, "$.plan_revision").is_(None),
                func.json_extract(Run.state_json, "$.plan_revision") <= rt.plan_revision), **values)
        await db.commit()


async def restore(rt: RunRuntime, run: Run) -> None:
    st = run.state_json or {}
    rt.status.update(st.get("status", {}))
    rt.done_agents = set(st.get("done_agents", []))
    rt.broken_files = dict(st.get("broken_files", {}))
    rt.unverified = dict(st.get("unverified", {}))
    rt.wf = st.get("workflow") or None
    rt.agent_turns = Counter(st.get("agent_turns", {}))
    rt.agent_tokens = Counter(st.get("agent_tokens", {}))
    rt.agent_cost = Counter(st.get("agent_cost", {}))
    rt.usage_totals = Counter(st.get("usage_totals", {}))
    rt.cost_totals = Counter(st.get("cost_totals", {}))
    rt.llm_calls = st.get("llm_calls", 0)
    rt.edge_counts = Counter(st.get("edge_counts", {}))
    rt.debates = {k: DebateState.from_dict(v) for k, v in st.get("debates", {}).items()}
    rt.reviews = {k: ReviewState.from_dict(v) for k, v in st.get("reviews", {}).items()}
    if st.get("loop"):
        rt.loop = LoopDetector.from_dict(st["loop"])
    rt.task_counter = st.get("task_counter", 0)
    rt.decisions, rt.user_notes = st.get("decisions", []), st.get("user_notes", [])
    rt.followups = st.get("followups", [])
    rt.agent_state = st.get("agent_state", {})
    rt.active_seconds = float(st.get("active_seconds", 0))
    rt.awaiting = st.get("awaiting")
    rt.rejections = st.get("rejections", 0)
    rt.policy.auto_approve = set(st.get("auto_approve", []))
    rt.self_turns = Counter(st.get("self_turns", {}))
    rt.progress_turn = int(st.get("progress_turn", rt.turn_no))
    rt.nudged = dict(st.get("nudged", {}))
    rt.stall_ack = int(st.get("stall_ack", rt.turn_no))
    rt.journal = list(st.get("journal", []))
    rt.journal_n = int(st.get("journal_n", len(rt.journal)))
    rt.seen = dict(st.get("seen", {}))
    rt.seen_turn = dict(st.get("seen_turn", {}))
    m = st.get("metrics") or {}
    rt.metrics = Counter({k: int(m.get(k, 0)) for k in ("turns", "work_turns", "delegations", "parallel_delegations")})
    rt.first_deliverable_turn = m.get("first_deliverable_turn")
    async with rt.db() as db:
        msgs = await MessageRepository(db).for_run(rt.run_id)
        for m in msgs:
            rec = rt._rec(m)
            rt.history.append(rec)
            if not m.read and m.to_agent_id in rt.agents:
                rt.seq += 1
                rt.mailbox.setdefault(m.to_agent_id, []).append((rt.seq, m.id))
        for t in await TaskRepository(db).for_run(rt.run_id):
            rt.tasks[t.key] = rt._task_dict(t)
        for a in await ArtifactRepository(db).for_run(rt.run_id):
            rt.artifacts[a.path] = {"version": a.version, "author": a.author_agent_id, "note": a.change_note, "deleted": a.deleted}
    for aid, obs in st.get("observations", {}).items():
        for o in obs:
            rt.seq += 1
            rt.observations.setdefault(aid, []).append((rt.seq, o))
    await rt._load_memory()


async def _load_memory(rt: RunRuntime) -> None:
    # Legacy notes are imported once into scoped, versioned records. Prompts
    # retrieve that authorized view rather than a second mutable cache.
    for agent in rt.agents.values():
        agent.memory.clear()


async def set_run_status(rt: RunRuntime, status: str, reason: str = "") -> None:
    if status == rt.run_status and not reason:
        return
    rt.run_status = status
    values: dict[str, Any] = {"status": status}
    if reason:
        values["halt_reason"] = reason[:200]
    async with rt.db() as db:
        await RunRepository(db).update(rt.run_id, **values)
        await db.commit()
    await rt.emit("run_status", {"status": status, "reason": reason, "awaiting": rt.awaiting,
                                   "pending_approval": rt.pending_approval})


async def set_agent_status(rt: RunRuntime, aid: str, status: str, activity: str = "") -> None:
    if rt.status.get(aid) != status or rt.activity.get(aid, "") != activity:
        rt.status[aid] = status
        rt.activity[aid] = activity
        await rt.emit("agent_status", {"agent_id": aid, "status": status, "activity": activity})


async def usage_event(rt: RunRuntime) -> None:
    await rt.emit("usage_update", {
        "tokens": rt.tokens, "cost_usd": round(rt.cost, 8), "turns": rt.turn_no,
        "max_turns": rt.budget.max_turns, "max_tokens": rt.budget.max_tokens, "max_cost_usd": rt.budget.max_cost_usd,
        "per_agent": dict(rt.agent_tokens), "active_seconds": round(rt.active_seconds, 1), "timeout_s": rt.budget.timeout_s,
        "per_agent_cost": {k: round(v, 6) for k, v in rt.agent_cost.items()},
        "input_tokens": rt.usage_totals["input"], "cached_tokens": rt.usage_totals["cached"],
        "cache_write_tokens": rt.usage_totals["cache_write"], "output_tokens": rt.usage_totals["output"],
        "reasoning_tokens": rt.usage_totals["reasoning"], "llm_calls": rt.llm_calls,
        "estimated_calls": rt.usage_totals["estimated_calls"],
        "cost_breakdown": {k: round(v, 6) for k, v in rt.cost_totals.items()},
        "progress_turn": rt.progress_turn, "turns_since_progress": rt.turn_no - rt.progress_turn,
    })


def add_usage(rt: RunRuntime, agent_id: str | None, u: Any) -> None:
    """Accumulate one LLM call's exact usage (as reported by Azure) and its priced cost."""
    rt.tokens += u.total_tokens
    rt.cost += u.cost_usd
    rt.llm_calls += 1
    if getattr(u, "estimated", False):
        rt.usage_totals["estimated_calls"] += 1
    rt.usage_totals.update({"input": u.prompt_tokens, "cached": u.cached_tokens, "cache_write": u.cache_write_tokens,
                              "output": u.completion_tokens, "reasoning": u.reasoning_tokens})
    rt.cost_totals.update({k: v for k, v in (u.cost_breakdown or {}).items() if v})
    if agent_id:
        rt.agent_tokens[agent_id] += u.total_tokens
        rt.agent_cost[agent_id] += u.cost_usd
