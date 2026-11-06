"""One global approval mode per user ("ask" or "auto", Approve for me); drop the per-workspace permission level

Legacy permission levels (read_only, plan, danger) no longer exist. Every user starts on "ask".

Revision ID: 0005_registry
Revises: 0004_registry
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0005_registry'
down_revision = '0004_registry'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('approval_mode', sa.String(length=10), nullable=False, server_default='ask'))
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.drop_column('default_permission')


def downgrade() -> None:
    with op.batch_alter_table('workspaces', schema=None) as batch_op:
        batch_op.add_column(sa.Column('default_permission', sa.String(length=20), nullable=False, server_default='ask'))
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('approval_mode')
