"""set_track, moved out of WorkflowMixin. Phase 5 moves it again."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.workflows.company import PHASES, TRACKS, pick_owner

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


async def act_set_track(rt: RunRuntime, agent: AgentSpec, a: A.SetTrack) -> None:
    cid = await rt._tool_event(agent, "set_track", {"track": a.track, "research": a.research})
    ph = rt.wf_phase()
    if not (ph and ph["key"] == "intake" and agent.is_entry):
        await rt.deny(agent, cid, "set_track", "set_track is only for the company head during intake.")
        return
    keys = [k for k in TRACKS[a.track] if k != "research" or a.research]
    agents = list(rt.agents.values())
    head = rt.agents[ph["owner"]]
    overrides = {k.lower(): rt.resolve_agent(v) for k, v in (a.owners or {}).items()}
    phases, builder = [], None
    for k in keys:
        if k in ("intake", "accept"):
            phases.append({"key": k, "owner": head.id, "status": "done" if k == "intake" else "pending", "bounces": 0, "loops": 0, "summary": ""})
            continue
        exclude = {head.id} | ({builder} if builder and k in ("test", "review") else set())  # independent checks
        owner_id = overrides.get(k) or (o.id if (o := pick_owner(agents, PHASES[k], exclude=exclude, goal=rt.goal)) else None)
        if k == "build" and owner_id is None:
            owner_id = head.id  # somebody has to build it
        if k == "build":
            builder = owner_id
        phases.append({"key": k, "owner": owner_id, "status": "pending" if owner_id else "skipped", "bounces": 0, "loops": 0, "summary": ""})
    if a.track == "quick":  # one independent check is enough for a quick goal: a tester, else a reviewer
        test = next(p for p in phases if p["key"] == "test")
        review = next(p for p in phases if p["key"] == "review")
        if test["status"] != "skipped" and review["status"] != "skipped":
            review.update({"status": "skipped", "owner": None})
    rt.wf.update({"track": a.track, "phases": phases, "index": 0, "reason": a.reason[:500]})
    ph = phases[0]
    ph["summary"] = a.reason[:500]
    plan = ", ".join(f"{PHASES[p['key']].title}: {rt.names.get(p['owner'], '-')}" for p in phases[1:] if p["status"] != "skipped")
    skipped = [PHASES[p["key"]].title for p in phases if p["status"] == "skipped"]
    rt.decide(f"Track {a.track}: {plan}" + (f" (skipped, nobody suited: {', '.join(skipped)})" if skipped else ""), agent.id)
    rt.mark_progress()
    await rt._tool_result(agent, cid, "set_track", True, a.track)
    rt.notice(agent.id, f"Track set: {a.track}. Plan: {plan}." + (f" Skipped (nobody suited): {', '.join(skipped)}." if skipped else "")
                + " Octopus now briefs each owner in turn and comes back to you for acceptance; end your turn.")
    await rt.wf_advance()
