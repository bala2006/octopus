"""Serve project files for the live preview (iframe / new tab / the agents' browser).

The page runs in a CSP sandbox (opaque origin, no cookies or storage, no access to the Octopus UI or API). ``'self'``
doesn't match anything for an opaque origin, so the preview base URL is allowed explicitly; that is what makes linked
CSS / JS / images of a multi-file app load. CDN resources over https are allowed; the Octopus API is not.
"""
from __future__ import annotations

import mimetypes
import posixpath

from fastapi import HTTPException
from fastapi.responses import Response

from app.tools.workspace import MAX_FILE_BYTES, ProjectFS, WorkspaceError

SAFE_MIME_PREFIXES = ("text/", "image/", "font/", "audio/", "video/")
SAFE_MIMES = {"application/javascript", "application/json", "application/wasm", "application/xml", "application/pdf",
              "application/manifest+json"}
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("font/woff2", ".woff2")


def csp(base_url: str) -> str:
    src = f"{base_url} https: data: blob:"
    return "; ".join([
        "sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock",
        f"default-src {src}",
        f"script-src {src} 'unsafe-inline' 'unsafe-eval'",
        f"style-src {src} 'unsafe-inline'",
        f"connect-src {base_url} https: wss: data: blob:",
        "form-action 'none'",
        "frame-ancestors 'self'",
    ])


def serve(fs: ProjectFS, path: str, base_url: str) -> Response:
    rel = (path or "").strip("/") or "index.html"
    try:
        found = fs.current_file(rel)
        if found is None and posixpath.splitext(rel)[1] == "":  # folder → its index.html
            found = fs.current_file(posixpath.join(rel, "index.html"))
    except WorkspaceError as exc:
        raise HTTPException(400, str(exc)) from exc
    if found is None:
        raise HTTPException(404, f"{rel} not found in the project")
    rel, file = found
    if file.stat().st_size > 20 * MAX_FILE_BYTES:
        raise HTTPException(413, "File too large to preview")
    mime = mimetypes.guess_type(rel)[0] or "text/plain"
    if not (mime.startswith(SAFE_MIME_PREFIXES) or mime in SAFE_MIMES):
        mime = "text/plain"
    if mime == "image/svg+xml" or mime.startswith("text/") or mime in ("application/javascript", "application/json"):
        mime += "; charset=utf-8"
    return Response(file.read_bytes(), media_type=mime, headers={
        "Content-Security-Policy": csp(base_url), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
    })
