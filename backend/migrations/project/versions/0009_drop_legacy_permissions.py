"""Drop the agent permission level and the plan-mode artifact flag

Legacy permission levels no longer exist, so agents have no permission override. Artifacts that were saved as plan
proposals keep their rows. They lose the "planned" flag and show as ordinary artifact versions.

Revision ID: 0009_drop_legacy_permissions
Revises: 0008_artifact_deletions
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0009_drop_legacy_permissions'
down_revision = '0008_artifact_deletions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('agents', schema=None) as batch_op:
        batch_op.drop_column('permission_level')
    with op.batch_alter_table('artifacts', schema=None) as batch_op:
        batch_op.drop_column('planned')


def downgrade() -> None:
    with op.batch_alter_table('artifacts', schema=None) as batch_op:
        batch_op.add_column(sa.Column('planned', sa.Boolean(), nullable=False, server_default=sa.false()))
    with op.batch_alter_table('agents', schema=None) as batch_op:
        batch_op.add_column(sa.Column('permission_level', sa.String(length=20), nullable=False, server_default='inherit'))
