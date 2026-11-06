"""API channel: the REST routers under /api/v1, the project routers under /api/v1/w/{workspace_id}, and /api/health.

The routers are included in the same order, with the same prefixes, as the router list that used to sit in app/main.py.
Route handlers live in app/api/v1 and are unchanged.
"""
from __future__ import annotations

from fastapi import APIRouter, FastAPI, Request

from app.channels.api.routes import activity, agents, auth, companies, editor, memory, plugins, roles, runs, sessions, settings, skills, templates, workspaces
from app.foundation.config import get_settings
from app.sdk.manifest import Manifest
from app.channels import Channel

# Mounted directly under /api/v1. These do not depend on a workspace.
GLOBAL_ROUTERS = (activity.router, auth.router, templates.router, roles.router, skills.router, settings.router,
                  workspaces.router, plugins.router)
# Mounted under /api/v1/w/{workspace_id}.
PROJECT_ROUTERS = (companies.router, agents.router, sessions.router, runs.router, editor.router, memory.router)


class ApiChannel(Channel):
    manifest = Manifest(id="channel.api", slot="channel", kind="api", version="1.0.0", title="REST API",
                       description="The /api/v1 routes (OpenAPI) the web app and other clients call.",
                       provides=("http.api",), requires=("run.lifecycle", "bus.events"), permissions=("db",), required=True)

    def mount(self, app: FastAPI) -> None:
        s = get_settings()
        api = APIRouter(prefix="/api/v1")
        for r in GLOBAL_ROUTERS:
            api.include_router(r)
        project = APIRouter(prefix="/w/{workspace_id}")
        for r in PROJECT_ROUTERS:
            project.include_router(r)
        api.include_router(project)
        app.include_router(api)

        @app.get("/api/health", tags=["meta"])
        async def health(request: Request) -> dict[str, object]:
            return {"ok": True, "app": s.app_name, "live_runs": len(request.app.state.kernel.runs.runtimes)}
