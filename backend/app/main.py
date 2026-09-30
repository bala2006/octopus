"""Octopus API entrypoint. Runs fully locally: ``uvicorn app.main:app`` (serves the built UI too)."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import ws
from app.api.v1 import agents, auth, companies, runs, sessions, settings, templates, workspaces
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger
from app.core.ratelimit import RateLimitMiddleware
from app.db.migrate import upgrade_registry
from app.db.session import dispose_all
from app.orchestrator.engine import manager

log = get_logger("app")
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


@asynccontextmanager
async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
    configure_logging()
    s = get_settings()
    await asyncio.to_thread(upgrade_registry, s.registry_database_url)
    log.info("octopus_started", home=str(s.octopus_home), demo_mode=s.demo_mode, roots=s.workspace_allowed_roots)
    yield
    from app.services.browser import browser

    await manager.shutdown()
    await browser.shutdown()
    await dispose_all()


def create_app() -> FastAPI:
    s = get_settings()
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

    api = APIRouter(prefix="/api/v1")
    for r in (auth.router, templates.router, settings.router, workspaces.router):
        api.include_router(r)
    project = APIRouter(prefix="/w/{workspace_id}")
    for r in (companies.router, agents.router, sessions.router, runs.router):
        project.include_router(r)
    api.include_router(project)
    app.include_router(api)
    app.include_router(ws.router)

    @app.get("/api/health", tags=["meta"])
    async def health() -> dict[str, object]:
        return {"ok": True, "app": s.app_name, "demo_mode": s.demo_mode, "live_runs": len(manager.runtimes)}

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:  # pragma: no cover
        log.exception("unhandled_error", path=request.url.path)
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    if FRONTEND_DIST.is_dir():  # single-process local mode: serve the built SPA
        app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        async def spa(full_path: str) -> FileResponse:
            f = (FRONTEND_DIST / full_path).resolve()
            if full_path and f.is_file() and FRONTEND_DIST in f.parents:
                return FileResponse(f)
            return FileResponse(FRONTEND_DIST / "index.html")

    return app


app = create_app()
