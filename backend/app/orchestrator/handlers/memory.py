"""remember: a proposed write to scoped memory."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime


async def act_remember(rt: RunRuntime, agent: AgentSpec, a: A.Remember) -> None:
    cid = await rt._tool_event(agent, "remember", {"key": a.key, "scope": a.scope})
    from app.services import scoped_memory as memory
    actor = memory.Actor(rt.user_id, rt.company_id, agent.id)
    target = (memory.Target("project", rt.company_id) if a.scope == "project" else
              memory.Target("chat", rt.run_id) if a.scope == "chat" else
              memory.Target("group", a.scope_id or "") if a.scope == "group" else memory.Target("agent", agent.id))
    try:
        await memory.put(rt.sf, actor, target, a.key, a.value, expected_version=a.expected_version,
                         refs=tuple(memory.SourceRef(ref.get("kind", ""), ref.get("id", "")) for ref in a.sources))
        await rt._tool_result(agent, cid, "remember", True, "Stored as a proposed scoped observation. The owner can review it.")
    except (memory.MemoryDenied, ValueError) as exc:
        await rt._tool_result(agent, cid, "remember", False, str(exc))
    return
