"""web_search and calculate."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.sdk import actions as A
from app.sdk.agents import AgentSpec
from app.plugins.tools import basic

if TYPE_CHECKING:  # pragma: no cover
    from app.sdk.run import RunContext


async def act_calculate(rt: RunContext, agent: AgentSpec, a: A.Calculate) -> None:
    cid = await rt._tool_event(agent, "calculate", {"expression": a.expression})
    try:
        out, ok = basic.calculate(a.expression), True
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, TypeError) as exc:
        out, ok = f"error: {exc}", False
    rt.observe(agent.id, {"tool": "calculate", "ok": ok, "content": f"{a.expression} = {out}"})
    await rt._tool_result(agent, cid, "calculate", ok, out)


async def act_web_search(rt: RunContext, agent: AgentSpec, a: A.WebSearch) -> None:
    cid = await rt._tool_event(agent, "web_search", {"query": a.query})
    ok, reason = await rt.guard(agent, "web_search", f"{agent.name} wants to search the web", a.query, {"query": a.query})
    if not ok:
        await rt.deny(agent, cid, "web_search", reason)
        return
    out = await basic.web_search(a.query)
    rt.observe(agent.id, {"tool": "web_search", "ok": True, "content": out})
    await rt._tool_result(agent, cid, "web_search", True, out)
