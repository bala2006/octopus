"""Persist dependency, scope, acceptance and budget contracts for existing tasks."""
from alembic import op
import sqlalchemy as sa

revision = "0007_task_constraints"
down_revision = "0006_memory_group_active"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("constraints_json", sa.JSON(), nullable=False, server_default="{}"))


def downgrade() -> None:
    op.drop_column("tasks", "constraints_json")
