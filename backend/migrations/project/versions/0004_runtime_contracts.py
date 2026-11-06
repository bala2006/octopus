"""Durable execution records. Existing runs and artifacts are preserved."""
from alembic import op
from app.models.runtime_records import RunRequest, TaskAttempt, ExecutionEvidence, Consultation

revision = "0004_runtime_contracts"
down_revision = "0003_project"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    for model in (RunRequest, TaskAttempt, ExecutionEvidence, Consultation):
        model.__table__.create(bind, checkfirst=True)


def downgrade():
    for model in (Consultation, ExecutionEvidence, TaskAttempt, RunRequest):
        model.__table__.drop(op.get_bind(), checkfirst=True)
