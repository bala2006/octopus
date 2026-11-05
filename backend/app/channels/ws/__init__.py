"""WebSocket channel: mounts the run, browser live-view, and chat sockets.

The endpoints are defined in app/api/ws.py, which this channel does not change. The socket paths are
/ws/w/{workspace_id}/runs/{run_id}, /ws/w/{workspace_id}/runs/{run_id}/browser/{agent_id}, and
/ws/w/{workspace_id}/chat/{session_id}.

The catalog has one entry for both HTTP and WebSocket (channel.api_ws, provides ws.events), so this channel reuses it.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.api import ws as ws_endpoints
from app.channels import catalog_manifest
from app.core.manifest import Manifest


class WsChannel:
    manifest: Manifest = catalog_manifest("channel.api_ws")

    def mount(self, app: FastAPI) -> None:
        app.include_router(ws_endpoints.router)
