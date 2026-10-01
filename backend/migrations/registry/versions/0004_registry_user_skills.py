"""user skills (edited built-in skills and custom skills)

Revision ID: 0004_registry
Revises: 0003_registry
Create Date: 2026-10-01 17:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0004_registry'
down_revision = '0003_registry'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('user_skills',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('user_id', sa.String(length=36), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('roles', sa.Text(), nullable=False),
    sa.Column('phases', sa.Text(), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_skills_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_skills')),
    sa.UniqueConstraint('user_id', 'name', name='uq_user_skill_name')
    )
    with op.batch_alter_table('user_skills', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_skills_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('user_skills', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_user_skills_user_id'))
    op.drop_table('user_skills')
