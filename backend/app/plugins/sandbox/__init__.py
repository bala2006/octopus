"""Sandbox runner plugin: runs agent commands without a shell and manages the long-lived processes the workbench starts."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin
from app.plugins.sandbox.deps import deps


def _commands():
    from app.plugins.sandbox import commands
    return commands


def _processes():
    from app.plugins.sandbox import processes
    return processes


async def _stop() -> None:
    from app.plugins.sandbox import processes
    await processes.servers.shutdown()
    await processes.commands.shutdown()


PLUGINS = (
    ServicePlugin(
        Manifest(id="runner.sandbox", slot="runner", kind="sandbox", version="1.0.0", title="Command sandbox",
                 description="Runs commands without a shell, with a scrubbed environment, limits and a timeout, and manages dev servers.",
                 provides=("sandbox.exec", "sandbox.processes"), requires=(), optional=("workspace.environments",),
                 permissions=("exec", "fs_read", "fs_write", "network"), start="lazy", required=True),
        services={"sandbox.exec": _commands, "sandbox.processes": _processes}, deps=deps, on_stop=_stop),
)
