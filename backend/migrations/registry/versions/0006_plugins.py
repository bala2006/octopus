"""plugins table: enabled state and version per plugin (nothing reads it yet)

Revision ID: 0006_registry
Revises: 0005_registry
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0006_registry'
down_revision = '0005_registry'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('plugins',
    sa.Column('id', sa.String(length=120), nullable=False),
    sa.Column('enabled', sa.Boolean(), server_default=sa.true(), nullable=False),
    sa.Column('version', sa.String(length=40), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_plugins'))
    )


def downgrade() -> None:
    op.drop_table('plugins')
