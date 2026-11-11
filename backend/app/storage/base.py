from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class RegistryBase(DeclarativeBase):
    """Global, per-installation data: users, secrets, MCP servers, the list of project workspaces."""

    metadata = MetaData(naming_convention=NAMING)


class ProjectBase(DeclarativeBase):
    """Per-project data stored in <project>/.octopus/octopus.db."""

    metadata = MetaData(naming_convention=NAMING)


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
