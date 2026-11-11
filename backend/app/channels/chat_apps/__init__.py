"""Chat apps channel: a placeholder with status ``planned`` .

It has no routes, no UI, and no chat platform SDK. ``mount`` adds nothing to the app. Platform adapters come later.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.sdk.manifest import Manifest
from app.channels import Channel


class ChatAppsChannel(Channel):
    manifest = Manifest(id="channel.chat_apps", slot="channel", kind="chat", version="1.0.0", title="Chat apps",
                       description="Slack, Teams and similar. Planned: no routes yet.",
                       provides=("chat.apps",), requires=(), status="planned")

    def mount(self, app: FastAPI) -> None:
        """Register nothing. The placeholder has no routes yet."""
