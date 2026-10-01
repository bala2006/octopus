"""raise agents' saved output budget to the model maximum

Agents saved by earlier versions carry a default answer budget (2048, later 8192 / 16384, or an automatic 32768 /
64000 escalation). Azure documents 128,000 max output tokens for the GPT-6 family, so those defaults are upgraded.
Values a user typed themselves (anything else) are left alone.

Revision ID: 0003_project
Revises: 0002_project
"""
from __future__ import annotations

from alembic import op

revision = '0003_project'
down_revision = '0002_project'
branch_labels = None
depends_on = None

LEGACY = (2048, 8192, 16384, 32768, 64000)


def upgrade() -> None:
    op.execute(f"UPDATE agents SET max_tokens = 128000 WHERE max_tokens IS NULL OR max_tokens IN {LEGACY}")


def downgrade() -> None:
    pass  # the previous defaults were the bug
