"""WebSocket channel: mounts the run, browser live-view, and chat sockets.

The endpoints are defined in app/channels/ws/endpoints.py. The socket paths are
/ws/w/{workspace_id}/runs/{run_id}, /ws/w/{workspace_id}/runs/{run_id}/browser/{agent_id}, and
/ws/w/{workspace_id}/chat/{session_id}.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.channels.ws import endpoints as ws_endpoints
from app.sdk.manifest import Manifest
from app.channels import Channel


class WsChannel(Channel):
    manifest = Manifest(id="channel.ws", slot="channel", kind="ws", version="1.0.0", title="WebSocket",
                       description="Live run and chat events with replay from the last seen sequence number.",
                       provides=("ws.events",), requires=("run.lifecycle", "bus.events"), permissions=("db",), required=True)

    def mount(self, app: FastAPI) -> None:
        app.include_router(ws_endpoints.router)
