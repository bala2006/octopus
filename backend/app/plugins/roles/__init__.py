"""Role plugins: the built-in roles, the user's role library, and the chief's lead routing."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin


def _builtin():
    from app.plugins.roles import prompts
    return prompts


def _library():
    from app.plugins.roles import library
    return library


def _chief():
    from app.plugins.roles import chief
    return chief


PLUGINS = (
    ServicePlugin(
        Manifest(id="role.builtin", slot="role", kind="roles", version="1.0.0", title="Built-in roles",
                 description="The role prompts and defaults every template and hire starts from (CEO, PM, engineers, QA, ...).",
                 provides=("roles.builtin",), requires=(), required=True),
        services={"roles.builtin": _builtin}),
    ServicePlugin(
        Manifest(id="role.library", slot="role", kind="roles", version="1.0.0", title="Role library",
                 description="The user's edits to built-in roles and their own roles (Settings → Roles).",
                 provides=("roles.library",), requires=("roles.builtin",), permissions=("db",), ui=("settings/roles",)),
        services={"roles.library": _library}),
    ServicePlugin(
        Manifest(id="role.chief", slot="role", kind="router", version="1.0.0", title="Chief (lead routing)",
                 description="Chooses the accountable lead of a run and routes a message to its owner.",
                 provides=("roles.lead",), requires=(), required=True),
        services={"roles.lead": _chief}),
)
