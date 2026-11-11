"""Workspace plugin: worker stages and their integration, automatic file checks, git, worktrees, preview."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin
from app.plugins.workspace.deps import deps


def _stages():
    from app.plugins.workspace import stages
    return stages


def _checks():
    from app.plugins.workspace import checks
    return checks


def _environments():
    from app.plugins.workspace import worktrees
    return worktrees


PLUGINS = (
    ServicePlugin(
        Manifest(id="workspace.local", slot="workspace", kind="project files", version="1.0.0", title="Project workspace",
                 description="Worker stages and their integration, syntax checks for written files, local Python environments.",
                 provides=("workspace.stages", "workspace.checks", "workspace.environments"), requires=("sandbox.exec",),
                 permissions=("fs_read", "fs_write", "exec"), required=True),
        services={"workspace.stages": _stages, "workspace.checks": _checks, "workspace.environments": _environments}, deps=deps),
)
