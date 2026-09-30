"""Alembic environment for the Octopus project database (run programmatically, see app/db/migrate.py)."""
from __future__ import annotations

from alembic import context
from sqlalchemy import create_engine, pool

import app.models  # noqa: F401  (register tables)
from app.db.base import ProjectBase

config = context.config
target_metadata = ProjectBase.metadata


def _sync_url(url: str) -> str:
    return url.replace("+aiosqlite", "").replace("+asyncpg", "+psycopg")


def run_migrations_offline() -> None:
    context.configure(url=_sync_url(config.get_main_option("sqlalchemy.url")), target_metadata=target_metadata,
                      literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_sync_url(config.get_main_option("sqlalchemy.url")), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
