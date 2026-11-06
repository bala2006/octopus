"""Versioned cooperative application memory; host processes are not sandboxed by these ACLs."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import ProjectBase, new_id, utcnow


class MemoryGroup(ProjectBase):
    __tablename__ = "memory_groups"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class MemoryGroupMember(ProjectBase):
    __tablename__ = "memory_group_members"
    group_id: Mapped[str] = mapped_column(ForeignKey("memory_groups.id", ondelete="CASCADE"), primary_key=True)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), primary_key=True)


class MemoryHead(ProjectBase):
    """The only mutable memory row. CAS updates serialize append-only versions."""
    __tablename__ = "memory_heads"
    __table_args__ = (UniqueConstraint("company_id", "scope", "scope_id", "key", name="uq_memory_head_scope"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    scope: Mapped[str] = mapped_column(String(16))
    scope_id: Mapped[str] = mapped_column(String(36))
    key: Mapped[str] = mapped_column(String(200))
    version: Mapped[int] = mapped_column(Integer, default=0)


class MemoryRecord(ProjectBase):
    """Immutable content versions, including explicit tombstones and superseding decisions."""
    __tablename__ = "memory_records"
    __table_args__ = (UniqueConstraint("head_id", "version", name="uq_scoped_memory_version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    head_id: Mapped[str] = mapped_column(ForeignKey("memory_heads.id", ondelete="CASCADE"), index=True)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id", ondelete="SET NULL"), nullable=True)
    version: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    classification: Mapped[str] = mapped_column(String(16), default="proposed")
    source_refs: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    author_agent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    import_key: Mapped[str | None] = mapped_column(String(200), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
