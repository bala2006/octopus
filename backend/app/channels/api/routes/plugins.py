"""Plugins: list every plugin with its state, health and dependents, and switch plugins on and off (Settings → Plugins)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.channels.deps import current_user
from app.foundation.config import get_settings
from app.kernel.core import Kernel
from app.kernel.host import HostError
from app.sdk.manifest import SDK_VERSION
from app.storage.models import User
from app.storage.session import registry_factory

router = APIRouter(prefix="/plugins", tags=["plugins"])


class PluginHealthOut(BaseModel):
    state: str
    detail: str = ""


class PluginOut(BaseModel):
    id: str
    title: str
    description: str
    slot: str
    kind: str
    version: str
    status: str  # built | partly | planned
    required: bool  # part of the run loop: cannot be switched off
    enabled: bool
    state: str  # registered | started | stopped | disabled | blocked | failed
    error: str = ""
    health: PluginHealthOut
    provides: list[str]
    requires: list[str]
    optional: list[str]
    permissions: list[str]
    emits: list[str]
    ui: list[str]
    start: str
    sdk: str
    dependents: list[str]  # plugins that would be switched off with this one
    applies: str  # "now", or "restart" for channels (their routes are mounted when the app starts)


class PluginsOut(BaseModel):
    sdk_version: str
    plugins: list[PluginOut]
    event_log: dict[str, int]


class PluginToggleIn(BaseModel):
    enabled: bool
    cascade: bool = False  # also switch off the plugins that need this one (or on, the ones this one needs)


class PluginToggleOut(BaseModel):
    changed: list[str]
    state: PluginsOut


def _kernel(request: Request) -> Kernel:
    return request.app.state.kernel


def _view(kernel: Kernel) -> PluginsOut:
    rows = [PluginOut(**row, applies="restart" if row["slot"] == "channel" else "now") for row in kernel.host.describe()]
    return PluginsOut(sdk_version=SDK_VERSION, plugins=rows, event_log=kernel.eventlog.stats())


@router.get("", response_model=PluginsOut)
async def list_plugins(request: Request, health: bool = False, _: User = Depends(current_user)) -> PluginsOut:
    """Every plugin. ``health=true`` asks each running plugin for its current health first."""
    kernel = _kernel(request)
    if health:
        await kernel.host.check_health()
    return _view(kernel)


@router.patch("/{plugin_id}", response_model=PluginToggleOut)
async def toggle_plugin(plugin_id: str, body: PluginToggleIn, request: Request, _: User = Depends(current_user)) -> PluginToggleOut:
    """Switch a plugin on or off. The change is saved and takes effect for the next model call, tool call or run."""
    if not get_settings().single_user_mode:
        raise HTTPException(403, "Plugins are managed by the person who runs this Octopus server")
    kernel = _kernel(request)
    if plugin_id not in {row["id"] for row in kernel.host.describe()}:
        raise HTTPException(404, f"Unknown plugin {plugin_id}")
    try:
        changed = await kernel.host.set_enabled(registry_factory(), plugin_id, body.enabled, cascade=body.cascade)
    except HostError as exc:
        raise HTTPException(409, str(exc)) from exc
    return PluginToggleOut(changed=changed, state=_view(kernel))
