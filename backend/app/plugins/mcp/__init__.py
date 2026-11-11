"""MCP plugin: the client for stdio and HTTP MCP servers, and the loopback bridge that exposes granted tools to a worker."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin


def _client():
    from app.plugins.mcp import client
    return client


def _bridge():
    from app.plugins.mcp import worker_bridge
    return worker_bridge


PLUGINS = (
    ServicePlugin(
        Manifest(id="service.mcp", slot="service", kind="mcp", version="1.0.0", title="MCP client",
                 description="Talks to the MCP servers the user registered, and bridges granted tools to an OpenCode worker.",
                 provides=("mcp.client", "mcp.bridge"), requires=(), permissions=("network", "exec"), start="lazy"),
        services={"mcp.client": _client, "mcp.bridge": _bridge}),
)
