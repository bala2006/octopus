"""Schema-only dumps of both Alembic chains, taken after every migration runs on a fresh SQLite file."""
from __future__ import annotations

import re
import sqlite3
import tempfile
from collections.abc import Callable
from pathlib import Path

from app.db.migrate import upgrade_project, upgrade_registry

_TABLE_CONSTRAINT = ("CONSTRAINT ", "PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK")
_CREATE_TABLE = re.compile(r"(?s)^(CREATE TABLE[^(]*\()(.*)\)$")


def canonical_create(sql: str) -> str:
    """Put the table-level constraint clauses of a CREATE TABLE in a fixed order.

    SQLite treats table constraints as unordered, but the migrated text listed them in a different order from one run to the next
    (observed with Alembic's SQLite batch mode), so the raw text is not byte-stable. Columns keep their order, because it is part
    of the schema. Nothing is dropped.
    """
    match = _CREATE_TABLE.match(sql)
    if not match:
        return sql
    items = match.group(2).strip().split(", \n\t")
    columns = [item for item in items if not item.startswith(_TABLE_CONSTRAINT)]
    constraints = sorted(item for item in items if item.startswith(_TABLE_CONSTRAINT))
    return f"{match.group(1)}\n\t" + ", \n\t".join(columns + constraints) + "\n)"


def schema_sql(upgrade: Callable[[str], None]) -> str:
    """Run ``upgrade`` on an empty database and return every stored CREATE statement, sorted, one per block."""
    with tempfile.TemporaryDirectory(prefix="golden-schema-") as tmp:
        path = Path(tmp) / "schema.db"
        upgrade(f"sqlite+aiosqlite:///{path}")
        con = sqlite3.connect(path)
        try:
            rows = con.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall()
        finally:
            con.close()
    statements = sorted(canonical_create(row[0]) for row in rows)
    return "\n\n".join(f"{sql};" for sql in statements) + "\n"


def registry_sql() -> str:
    return schema_sql(upgrade_registry)


def project_sql() -> str:
    return schema_sql(upgrade_project)
