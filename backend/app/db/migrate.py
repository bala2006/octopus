"""Programmatic Alembic upgrades for the registry DB and each project's ``.octopus/octopus.db``."""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def _config(kind: str, url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS / kind))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def _sync(url: str) -> str:
    return url.replace("+aiosqlite", "").replace("+asyncpg", "+psycopg")


def upgrade_registry(url: str) -> None:
    command.upgrade(_config("registry", url), "head")


def upgrade_project(url: str) -> None:
    command.upgrade(_config("project", url), "head")
    # Runs that were live when the previous process exited cannot still be running: make them resumable.
    eng = create_engine(_sync(url))
    with eng.begin() as conn:
        conn.execute(text("UPDATE runs SET status='paused', halt_reason='Octopus restarted; press Resume to continue' "
                          "WHERE status IN ('queued','running')"))
    eng.dispose()
