"""add_site_events

Revision ID: a1b2c3d4e5f6
Revises: d29988510650
Create Date: 2026-07-30 09:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "d29988510650"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "site_events",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("start_time", sa.String(length=5), nullable=True),
        sa.Column("end_time", sa.String(length=5), nullable=True),
        sa.Column("dates_json", sa.JSON(), nullable=False),
        sa.Column("assignments_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_site_events_id"), "site_events", ["id"], unique=False)
    op.create_index(op.f("ix_site_events_site_id"), "site_events", ["site_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_site_events_site_id"), table_name="site_events")
    op.drop_index(op.f("ix_site_events_id"), table_name="site_events")
    op.drop_table("site_events")
