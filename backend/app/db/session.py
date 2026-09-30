"""Database engines.

- One *registry* engine (global): users, provider keys, MCP servers, workspaces.
- One *project* engine per workspace, pointing at ``<project>/.octopus/octopus.db``.
  Engines are cached and migrated (Alembic) the first time a project is opened.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import PROJECT_DIRNAME, get_settings

SessionFactory = async_sessionmaker[AsyncSession]

_registry: tuple[AsyncEngine, SessionFactory] | None = None
_projects: dict[str, tuple[AsyncEngine, SessionFactory]] = {}
_project_locks: dict[str, asyncio.Lock] = {}


def make_engine(url: str) -> AsyncEngine:
    kwargs: dict = {"future": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    eng = create_async_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(eng.sync_engine, "connect")
        def _pragmas(dbapi_conn, _):  # type: ignore[no-untyped-def]
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            if ":memory:" not in url:
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

    return eng


# ---------------------------------------------------------------- registry
def registry_factory() -> SessionFactory:
    global _registry
    if _registry is None:
        eng = make_engine(get_settings().registry_database_url)
        _registry = (eng, async_sessionmaker(eng, expire_on_commit=False))
    return _registry[1]


def registry_engine() -> AsyncEngine:
    registry_factory()
    assert _registry is not None
    return _registry[0]


def set_registry_url(url: str) -> None:
    """Replace the registry engine (tests)."""
    global _registry
    eng = make_engine(url)
    _registry = (eng, async_sessionmaker(eng, expire_on_commit=False))


async def get_registry_db() -> AsyncIterator[AsyncSession]:
    async with registry_factory()() as s:
        yield s


# ---------------------------------------------------------------- projects
def project_db_path(root: Path) -> Path:
    return root / PROJECT_DIRNAME / "octopus.db"


def project_url(root: Path) -> str:
    return f"sqlite+aiosqlite:///{project_db_path(root)}"


async def project_factory(workspace_id: str, root: Path) -> SessionFactory:
    """Return (and lazily create + migrate) the session factory of a project DB."""
    if workspace_id in _projects:
        return _projects[workspace_id][1]
    lock = _project_locks.setdefault(workspace_id, asyncio.Lock())
    async with lock:
        if workspace_id in _projects:
            return _projects[workspace_id][1]
        from app.db.migrate import upgrade_project

        (root / PROJECT_DIRNAME).mkdir(parents=True, exist_ok=True)
        url = project_url(root)
        await asyncio.to_thread(upgrade_project, url)
        eng = make_engine(url)
        _projects[workspace_id] = (eng, async_sessionmaker(eng, expire_on_commit=False))
        return _projects[workspace_id][1]


async def close_project(workspace_id: str) -> None:
    entry = _projects.pop(workspace_id, None)
    if entry:
        await entry[0].dispose()


async def dispose_all() -> None:
    for wid in list(_projects):
        await close_project(wid)
    if _registry:
        await _registry[0].dispose()
