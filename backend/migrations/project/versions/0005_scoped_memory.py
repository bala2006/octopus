"""Scoped append-only memory versions and explicit sharing groups."""
from alembic import op
import sqlalchemy as sa

revision = "0005_scoped_memory"
down_revision = "0004_runtime_contracts"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("memory_groups", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("company_id", sa.String(36), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False), sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.create_index("ix_memory_groups_company_id", "memory_groups", ["company_id"])
    op.create_table("memory_group_members",
        sa.Column("group_id", sa.String(36), sa.ForeignKey("memory_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("agent_id", sa.String(36), sa.ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True))
    op.create_table("memory_heads", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("company_id", sa.String(36), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("scope", sa.String(16), nullable=False), sa.Column("scope_id", sa.String(36), nullable=False),
        sa.Column("key", sa.String(200), nullable=False), sa.Column("version", sa.Integer(), nullable=False),
        sa.UniqueConstraint("company_id", "scope", "scope_id", "key", name="uq_memory_head_scope"))
    op.create_index("ix_memory_heads_company_id", "memory_heads", ["company_id"])
    op.create_table("memory_records", sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("head_id", sa.String(36), sa.ForeignKey("memory_heads.id", ondelete="CASCADE"), nullable=False),
        sa.Column("company_id", sa.String(36), sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id", ondelete="SET NULL"), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False), sa.Column("content", sa.Text(), nullable=False),
        sa.Column("classification", sa.String(16), nullable=False), sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.Column("author_agent_id", sa.String(36), nullable=True), sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("import_key", sa.String(200), nullable=True, unique=True), sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("head_id", "version", name="uq_scoped_memory_version"))
    op.create_index("ix_memory_records_head_id", "memory_records", ["head_id"])
    op.create_index("ix_memory_records_company_id", "memory_records", ["company_id"])


def downgrade() -> None:
    for table in ("memory_records", "memory_heads", "memory_group_members", "memory_groups"):
        op.drop_table(table)
