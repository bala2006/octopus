"""Skills knowledge plugin: the built-in skill library, the user's and the project's skills, and bundle pinning."""
from __future__ import annotations

from app.sdk.manifest import Manifest
from app.sdk.plugin import ServicePlugin


def _service():
    from app.plugins.skills import service
    return service


PLUGINS = (
    ServicePlugin(
        Manifest(id="knowledge.skills", slot="knowledge", kind="skills", version="1.0.0", title="Skills library",
                 description="Step-by-step playbooks (SKILL.md) from the built-in library, the user's settings and the project folder.",
                 provides=("skills.library",), requires=(), permissions=("fs_read", "db")),
        services={"skills.library": _service}),
)
