"""Browser plugin: a Playwright MCP server the agents use, one persistent tab per agent, and the live view of those tabs."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin
from app.plugins.browser.deps import deps


def _sessions():
    from app.plugins.browser import service
    return service


def _frames():
    from app.plugins.browser import frames
    return frames


async def _stop() -> None:
    from app.plugins.browser import service
    await service.browser.shutdown()


PLUGINS = (
    ServicePlugin(
        Manifest(id="service.browser", slot="service", kind="browser", version="1.0.0", title="Agent browser",
                 description="A real browser for agents (Playwright MCP on 127.0.0.1) with a live view for the user.",
                 provides=("browser.sessions", "browser.frames"), requires=("mcp.client",),
                 permissions=("network", "exec", "fs_write"), emits=("browser_action",), ui=("settings/browser",), start="lazy"),
        services={"browser.sessions": _sessions, "browser.frames": _frames}, deps=deps, on_stop=_stop),
)
