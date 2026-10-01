"""user roles (edited built-in roles and custom roles)

Revision ID: 0003_registry
Revises: 0002_registry
Create Date: 2026-10-01 16:00:00
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '0003_registry'
down_revision = '0002_registry'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('user_roles',
    sa.Column('id', sa.String(length=36), nullable=False),
    sa.Column('user_id', sa.String(length=36), nullable=False),
    sa.Column('key', sa.String(length=80), nullable=False),
    sa.Column('role', sa.String(length=120), nullable=False),
    sa.Column('category', sa.String(length=40), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('system_prompt', sa.Text(), nullable=False),
    sa.Column('default_name', sa.String(length=60), nullable=False),
    sa.Column('color', sa.String(length=20), nullable=False),
    sa.Column('avatar', sa.String(length=40), nullable=False),
    sa.Column('tools_json', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_roles_user_id_users'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_user_roles')),
    sa.UniqueConstraint('user_id', 'key', name='uq_user_role_key')
    )
    with op.batch_alter_table('user_roles', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_roles_user_id'), ['user_id'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('user_roles', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_user_roles_user_id'))
    op.drop_table('user_roles')
