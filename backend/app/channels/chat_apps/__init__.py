"""Chat apps channel: a placeholder with status ``planned`` (decision D3 in docs/architecture/refactor-plan.md).

It has no routes, no UI, and no chat platform SDK. ``mount`` adds nothing to the app. Platform adapters come later.
"""
from __future__ import annotations

from fastapi import FastAPI

from app.channels import catalog_manifest
from app.core.manifest import Manifest


class ChatAppsChannel:
    manifest: Manifest = catalog_manifest("channel.chat_apps")

    def mount(self, app: FastAPI) -> None:
        """Register nothing. The placeholder has no routes yet."""
