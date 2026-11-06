"""Record deleted file versions without losing original contents."""
from alembic import op
import sqlalchemy as sa

revision = "0008_artifact_deletions"
down_revision = "0007_task_constraints"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("artifacts", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("artifacts", "deleted")
