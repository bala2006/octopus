"""Octopus API entrypoint. Runs fully locally: ``uvicorn app.main:app`` (serves the built UI too).

Routes come from the channels in app/channels. This file builds the app-wide pieces: lifespan, middleware, CORS,
and the error handler. Mount order matters: the web shell's catch-all route must be added last.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.capabilities.bootstrap import install as install_capabilities
from app.channels.api import ApiChannel
from app.channels.web_shell import WebShellChannel
from app.channels.ws import WsChannel
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.ratelimit import RateLimitMiddleware
from app.db.migrate import upgrade_registry
from app.db.session import dispose_all
from app.orchestrator.engine import manager

log = get_logger("app")


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
    configure_logging()
    s = get_settings()
    await asyncio.to_thread(upgrade_registry, s.registry_database_url)
    log.info("octopus_started", home=str(s.octopus_home), roots=s.workspace_allowed_roots)
    yield
    from app.capabilities.browser.service import browser
    from app.capabilities.sandbox.processes import commands, servers

    await manager.shutdown()
    await browser.shutdown()
    await servers.shutdown()
    await commands.shutdown()
    await dispose_all()


def create_app() -> FastAPI:
    s = get_settings()
    install_capabilities()  # the core ports must be set before any run can call a model, read a project or load skills
    app = FastAPI(title="Octopus API", version="1.0.0", lifespan=lifespan,
                  description="Multi-agent orchestration platform: a virtual software company of AI agents.")
    app.add_middleware(RateLimitMiddleware, per_minute=s.rate_limit_per_minute)

    @app.middleware("http")
    async def remember_origin(request: Request, call_next):  # type: ignore[no-untyped-def]
        # the agents' browser opens project previews on the same host:port the user's browser uses
        host = request.headers.get("host", "")
        if request.url.path.startswith("/api/") and host.split(":")[0] in ("127.0.0.1", "localhost"):
            s.public_url = f"{request.url.scheme}://{host}"
        return await call_next(request)
    app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    ApiChannel().mount(app)
    WsChannel().mount(app)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
        log.exception("unhandled_error", path=request.url.path)
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    WebShellChannel().mount(app)  # last: the catch-all must come after every API route
    return app


app = create_app()
