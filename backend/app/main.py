"""Octopus API entrypoint. Runs fully locally: ``uvicorn app.main:app`` (serves the built UI too).

This file builds the app-wide pieces: the kernel, the lifespan, middleware, CORS and the error handler, and mounts the
channel plugins. Mount order matters: a channel that requires another is mounted after it, so the web shell's catch-all
route comes last.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.bootstrap import build_kernel
from app.channels.ratelimit import RateLimitMiddleware
from app.foundation.config import get_settings
from app.foundation.logging import configure_logging, get_logger
from app.kernel.core import Kernel
from app.storage.migrate import upgrade_registry
from app.storage.session import dispose_all, registry_factory

log = get_logger("app")


def create_app(kernel: Kernel | None = None) -> FastAPI:
    """Build the FastAPI app around ``kernel`` (a fresh, private one when none is given)."""
    s = get_settings()
    kernel = kernel if kernel is not None else build_kernel()

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        configure_logging()
        await asyncio.to_thread(upgrade_registry, s.registry_database_url)
        await kernel.start(registry_factory())
        log.info("octopus_started", home=str(s.octopus_home), roots=s.workspace_allowed_roots,
                 plugins=sum(1 for row in kernel.host.describe() if row["state"] in ("registered", "started")))
        yield
        await kernel.stop()
        await dispose_all()

    app = FastAPI(title="Octopus API", version="1.0.0", lifespan=lifespan,
                  description="Multi-agent orchestration platform: a virtual software company of AI agents.")
    app.state.kernel = kernel
    app.add_middleware(RateLimitMiddleware, per_minute=s.rate_limit_per_minute)

    @app.middleware("http")
    async def remember_origin(request: Request, call_next):  # type: ignore[no-untyped-def]
        # the agents' browser opens project previews on the same host:port the user's browser uses
        host = request.headers.get("host", "")
        if request.url.path.startswith("/api/") and host.split(":")[0] in ("127.0.0.1", "localhost"):
            s.public_url = f"{request.url.scheme}://{host}"
        return await call_next(request)
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    for channel in kernel.host.active("channel"):  # dependency order: the web shell's catch-all route is added last
        mount = getattr(channel, "mount", None)
        if mount is not None:
            mount(app)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
        log.exception("unhandled_error", path=request.url.path)
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    return app


app = create_app(build_kernel(make_current=True))
