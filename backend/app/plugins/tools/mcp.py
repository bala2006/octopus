"""mcp_call (MCP servers and the built-in browser) and the MCP grants resolved at run start."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.foundation.config import get_settings
from app.storage.repositories import McpServerRepository
from app.storage.session import registry_factory
from app.sdk import actions as A
from app.sdk.agents import AgentSpec

if TYPE_CHECKING:  # pragma: no cover
    from app.sdk.run import RunContext


async def load_mcp(rt: RunContext) -> None:
    """Resolve MCP servers granted to each agent (only the run owner's registered, enabled servers)."""
    await rt.load_roles()
    mcp = rt.services.get("mcp.client")
    sessions = rt.services.get("browser.sessions")
    if mcp is None:  # no MCP client plugin: no agent gets MCP servers
        return
    McpConfig = mcp.McpConfig
    server_name = sessions.SERVER_NAME if sessions is not None else "browser"

    wanted = {sid for a in rt.agents.values() for sid in (a.tools.get("mcp_servers") or [])}
    if wanted:
        async with registry_factory()() as rdb:
            rows = await McpServerRepository(rdb).enabled_for_user(wanted, rt.user_id)
        rt.mcp_configs = {r.id: McpConfig.from_row(r) for r in rows}
    for a in rt.agents.values():
        a.mcp = [{"id": c.id, "name": c.name, "tools": c.tools} for sid in (a.tools.get("mcp_servers") or [])
                 if (c := rt.mcp_configs.get(sid)) and c.name.lower() != server_name]
        if sessions is not None and A.tool_enabled(a.tools, "browser") and get_settings().browser_enabled:
            a.mcp.append({"id": sessions.SERVER_ID, "name": sessions.SERVER_NAME, "tools": sessions.browser.tool_list(), "builtin": True})


async def act_mcp_call(rt: RunContext, agent: AgentSpec, a: A.McpCall) -> None:
    mcp = rt.services.require("mcp.client")
    sessions = rt.services.get("browser.sessions")
    SERVER_ID = sessions.SERVER_ID if sessions is not None else None
    browser = sessions.browser if sessions is not None else None

    cid = await rt._tool_event(agent, f"mcp:{a.server}/{a.tool}", {"server": a.server, "tool": a.tool, "arguments": a.arguments})

    granted = {m["name"].lower(): m["id"] for m in agent.mcp}
    sid = granted.get(a.server.lower())
    if sid is not None and sid == SERVER_ID:  # built-in browser: one persistent, in-memory tab per agent
        needs_browser_approval = rt.level == "ask"
        if needs_browser_approval:
            ok, reason = await rt.guard(
                agent,
                "mcp_call",
                f"{agent.name} wants to use the browser tool {a.tool}",
                str(a.arguments),
                {"server": "browser", "tool": a.tool, "arguments": a.arguments},
            )
            if not ok:
                await rt.deny(agent, cid, "mcp_call", reason)
                return
        await rt.set_agent_status(agent.id, "tool", f"Browser: {a.tool.removeprefix('browser_')}…")
        rt.mark_work(agent.id)
        ok, out = await browser.call(rt.run_id, agent.id, a.tool, a.arguments)
        if not ok and not browser.available():
            out += ("\nThe browser can't run in this environment: don't retry it. Verify by reading the code instead, and say in "
                    "your report that nothing was tested in a real browser.")
            if "browser" not in rt.warned:
                rt.warned.add("browser")
                await rt.emit("error", {"kind": "warning", "agent_id": agent.id, "message": (
                    "The built-in browser is unavailable, so this run can only check the project by reading its source; "
                    f"'it works in the browser' is unverified. {browser.error.splitlines()[0] if browser.error else ''}")})
        rt.observe(agent.id, {"tool": f"browser/{a.tool}", "ok": ok, "content": out})
        await rt._tool_result(agent, cid, "mcp_call", ok, out)
        await rt._browser_action(agent, cid, a, ok, out)
        return
    cfg = rt.mcp_configs.get(sid) if sid else None
    if cfg is None:
        await rt.deny(agent, cid, "mcp_call", f"MCP server '{a.server}' is not granted to you. Granted: {', '.join(m['name'] for m in agent.mcp) or 'none'}")
        return
    if cfg.tools and a.tool not in {t["name"] for t in cfg.tools}:
        await rt.deny(agent, cid, "mcp_call", f"Unknown tool '{a.tool}' on MCP server '{cfg.name}'.")
        return
    ok, reason = await rt.guard(agent, "mcp_call", f"{agent.name} wants to call {cfg.name}/{a.tool}",
                                  str(a.arguments), {"server": cfg.name, "tool": a.tool, "arguments": a.arguments})
    if not ok:
        await rt.deny(agent, cid, "mcp_call", reason)
        return
    await rt.set_agent_status(agent.id, "tool", f"Calling {cfg.name}/{a.tool}…")
    rt.mark_work(agent.id)
    ok, out = await mcp.call_tool(cfg, a.tool, a.arguments)
    rt.observe(agent.id, {"tool": f"mcp:{cfg.name}/{a.tool}", "ok": ok, "content": out})
    await rt._tool_result(agent, cid, "mcp_call", ok, out)
