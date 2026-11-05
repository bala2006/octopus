"""Browser tool results: the page an agent is on and its live frame, for the run's Browser view."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.core.config import get_settings
from app.core.logging import get_logger
from app.orchestrator import actions as A
from app.orchestrator.context import AgentSpec

if TYPE_CHECKING:  # pragma: no cover
    from app.orchestrator.engine import RunRuntime

log = get_logger("orchestrator")


async def _browser_action(rt: RunRuntime, agent: AgentSpec, cid: str, a: A.McpCall, ok: bool, out: str) -> None:
    """Record what the agent did in its browser tab and what the tab showed afterwards (the run's Browser view)."""
    from app.capabilities.browser import frames as browser_frames
    from app.capabilities.browser.service import browser, page_info

    url, title = page_info(out)
    if (ok and a.tool in ("browser_snapshot", "browser_console_messages", "browser_click", "browser_take_screenshot")
            and url and (url.startswith(rt.preview_url()) or url.startswith(("http://localhost:", "http://127.0.0.1:")))):
        await rt.execution.refresh_execution_evidence()
    if url:
        rt.browser_pages[agent.id] = (url, title)
    else:
        url, title = rt.browser_pages.get(agent.id, ("", ""))
    frame = None
    if ok and get_settings().browser_live_frames:
        data = await browser.frame(rt.run_id, agent.id, a.tool)
        if data:
            try:
                frame = browser_frames.save(rt.run_id, data)
            except (OSError, ValueError) as exc:
                log.warning("browser_frame_not_saved", error=str(exc))
    args = {k: (v[:300] if isinstance(v, str) else v) for k, v in (a.arguments or {}).items()}
    await rt.emit("browser_action", {"agent_id": agent.id, "call_id": cid, "tool": a.tool, "args": args, "ok": ok,
                                       "url": url, "title": title[:200], "frame": frame,
                                       "note": "" if ok else out[:500], "turn_no": rt.turn_no})
