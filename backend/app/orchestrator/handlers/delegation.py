"""delegate: hand work to a teammate over a task channel."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec
from app.workflows.routing import allowed_recipients, find_channel, rejection_reason

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


def brief_text(rt: RunRuntime, delegator: AgentSpec, a: A.Delegate) -> str:
    parts = [f"Objective: {a.objective.strip()}"]
    if a.deliverable.strip():
        parts.append(f"Deliverable: {a.deliverable.strip()}")
    if a.done_when.strip():
        parts.append(f"Done when: {a.done_when.strip()}")
    if a.context.strip():
        parts.append(f"Context: {a.context.strip()}")
    return "\n".join(parts)


async def act_delegate(rt: RunRuntime, agent: AgentSpec, a: A.Delegate) -> None:  # JSON-envelope path
    rt.notice(agent.id, await rt.delegate(agent, a))


async def delegate(rt: RunRuntime, agent: AgentSpec, a: A.Delegate) -> str:
    """Hand work to a teammate over a delegate channel. Inside a native tool loop the teammate's sub-turn runs right away
        and its result is returned; otherwise (JSON envelope, or depth/cycle limits) it becomes a task message."""
    tid = rt.resolve_agent(a.to)
    if tid is None:
        can = [rt.names[r] for r, es in allowed_recipients(rt.edges, agent.id).items() if any(e.type == "delegate" for e in es)]
        return f"Not delegated: unknown teammate '{a.to}'. You can delegate to: {', '.join(can) or 'nobody'}."
    if tid == agent.id:
        return "Not delegated: that's you. Just do the work."
    worker = rt.agents[tid]
    if not worker.active:
        return f"Not delegated: {worker.name} is inactive."
    edge = find_channel(rt.edges, agent.id, tid, "task")
    if edge is None:
        return "Not delegated: " + rejection_reason(rt.edges, agent.id, tid, "task", rt.names)
    brief = rt.brief_text(agent, a)
    chain = [*rt.delegation_chains.get(agent.id, []), agent.id]
    if tid in chain or len(chain) > rt.budget.max_delegation_depth:
        return "Not delegated: delegation cycle or depth limit reached. Escalate to the accountable lead."
    if rt.mailbox.get(tid) or rt.status.get(tid) in ("thinking", "working", "waiting_reply"):
        return f"Not delegated: {worker.name} already has an active assignment. Wait for its result or choose an idle agent."
    rt.delegation_chains[tid] = chain
    rt.metrics["delegations"] += 1
    await rt._send_one(agent, tid, A.SendMessage(action="send_message", to=worker.name, type="task", content=brief, task_id=a.task_id))
    return (f"Queued an owned assignment for {worker.name}. The scheduler will return their result here. "
            "Call wait while dependent work is pending; do not finish the run before reviewing the result.")
