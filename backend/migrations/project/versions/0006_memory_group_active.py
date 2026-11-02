"""Ensure older development versions of scoped-memory groups can be archived."""
from alembic import op
import sqlalchemy as sa

revision = "0006_memory_group_active"
down_revision = "0005_scoped_memory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("memory_groups")}
    if "active" not in columns:
        op.add_column("memory_groups", sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    pass  # Both forms of 0005 exist in development; never remove a column owned by current 0005.
