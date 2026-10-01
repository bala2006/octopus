"""run archive: full tool outputs and long tool arguments under short references, for recall / search_history

Revision ID: 0004_project
Revises: 0003_project
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = '0004_project'
down_revision = '0003_project'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('run_records',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('run_id', sa.String(length=36), nullable=False),
    sa.Column('ref', sa.String(length=16), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('agent_id', sa.String(length=36), nullable=True),
    sa.Column('turn_no', sa.Integer(), nullable=False),
    sa.Column('title', sa.String(length=300), nullable=False),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['run_id'], ['runs.id'], name=op.f('fk_run_records_run_id_runs'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_run_records')),
    sa.UniqueConstraint('run_id', 'ref', name='uq_run_record_ref')
    )
    with op.batch_alter_table('run_records', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_run_records_run_id'), ['run_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('run_records', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_run_records_run_id'))
    op.drop_table('run_records')
