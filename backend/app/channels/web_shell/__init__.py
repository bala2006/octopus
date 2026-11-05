"""Web shell channel: serves the built UI (frontend/dist) from the API process.

Mounts /assets (the build's static files) and a catch-all GET route. The catch-all returns a file from the build when
the path names one, and otherwise returns index.html so client-side routes load. Nothing is mounted when there is no
build, so the API runs alone in dev mode. The catch-all must be the last route added, so mount this channel last.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.channels import catalog_manifest
from app.core.manifest import Manifest

# This file is backend/app/channels/web_shell/__init__.py, so the repo root is four levels above its directory.
DEFAULT_DIST = Path(__file__).resolve().parents[4] / "frontend" / "dist"


class WebShellChannel:
    manifest: Manifest = catalog_manifest("channel.web_shell")

    def __init__(self, dist: Path | None = None) -> None:
        self.dist = dist

    def mount(self, app: FastAPI) -> None:
        dist = self.dist if self.dist is not None else DEFAULT_DIST
        if not dist.is_dir():
            return
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str) -> FileResponse:
            f = (dist / full_path).resolve()
            if full_path and f.is_file() and dist in f.parents:
                return FileResponse(f)
            return FileResponse(dist / "index.html")
