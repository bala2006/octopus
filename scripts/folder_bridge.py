#!/usr/bin/env python3
"""Octopus folder picker for Docker: shows your laptop's own "choose folder" dialog.

When the Octopus backend runs in Docker it has no access to your desktop, so it can't open the system folder dialog.
This tiny helper runs on the laptop instead (standard library only, any Python 3.9+): the Octopus UI in your browser
asks it to show the dialog, gets back the folder you picked (e.g. ``C:\\Users\\me\\code\\game``), and Octopus opens it
through the folder shared with the container.

    python scripts/folder_bridge.py          # start.bat / start.sh run this for you

Security: it listens on 127.0.0.1 only, answers only the Octopus UI's own origins (OCTOPUS_UI_ORIGINS), and the only
thing it can do is show a folder dialog and return the path you chose.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.services import native_dialog  # noqa: E402  (standard-library only)

PORT = int(os.environ.get("OCTOPUS_BRIDGE_PORT", "8765"))
ORIGINS = {o.strip().rstrip("/") for o in os.environ.get(
    "OCTOPUS_UI_ORIGINS",
    "http://localhost:8080,http://127.0.0.1:8080,http://localhost:8000,http://127.0.0.1:8000,http://localhost:5173,http://127.0.0.1:5173",
).split(",") if o.strip()}
_one_at_a_time = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "OctopusFolderBridge/1"
    picker = staticmethod(native_dialog.pick_directory_sync)  # replaced in tests

    def _origin_ok(self) -> bool:
        return (self.headers.get("Origin") or "").rstrip("/") in ORIGINS

    def _send(self, status: int, body: dict | None = None) -> None:
        data = json.dumps(body or {}).encode()
        self.send_response(status)
        if self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")  # Chrome's Private Network Access preflight
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204 if self._origin_ok() else 403)

    def do_GET(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed"})
        if self.path.rstrip("/") != "/health":
            return self._send(404, {"error": "not found"})
        av = native_dialog.availability(True)
        self._send(200, {"ok": av.available, "method": av.method, "reason": av.reason, "platform": sys.platform})

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_ok():
            return self._send(403, {"error": "origin not allowed"})
        if self.path.rstrip("/") != "/pick":
            return self._send(404, {"error": "not found"})
        if not _one_at_a_time.acquire(blocking=False):
            return self._send(409, {"error": "A folder dialog is already open on this computer"})
        try:
            picked = type(self).picker(None)
        except native_dialog.DialogError as exc:
            return self._send(501, {"error": str(exc)})
        finally:
            _one_at_a_time.release()
        self._send(200, {"cancelled": picked is None, "path": str(picked) if picked else ""})

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("folder-bridge: " + (fmt % args) + "\n")


def serve(port: int = PORT) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    av = native_dialog.availability(True)
    if not av.available:
        print(f"folder-bridge: the system folder dialog isn't available here: {av.reason}", file=sys.stderr)
    print(f"Octopus folder picker listening on http://127.0.0.1:{PORT} ({av.method or 'no dialog'})")
    try:
        serve().serve_forever()
    except KeyboardInterrupt:
        pass
