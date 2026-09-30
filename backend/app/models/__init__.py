"""ORM models.

Registry (global ``~/.octopus/registry.db``): User, ProviderKey, McpServer, Workspace.
Project (``<project>/.octopus/octopus.db``): Company, Agent, Edge, ChatSession, Run, Message, RunEvent,
Task, Artifact, AgentMemory.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import ProjectBase, RegistryBase, new_id, utcnow

PERMISSION_LEVELS = ("read_only", "plan", "ask", "danger")


# ====================================================================== registry
class User(RegistryBase):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Workspace(RegistryBase):
    """A project directory selected by the user. All project data lives in <path>/.octopus/."""

    __tablename__ = "workspaces"
    __table_args__ = (UniqueConstraint("user_id", "path", name="uq_workspace_path"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    path: Mapped[str] = mapped_column(String(1000))
    default_permission: Mapped[str] = mapped_column(String(20), default="ask")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_opened_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ProviderKey(RegistryBase):
    __tablename__ = "provider_keys"
    __table_args__ = (UniqueConstraint("user_id", "provider", name="uq_provider_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(40))
    encrypted_key: Mapped[str] = mapped_column(Text)
    base_url: Mapped[str] = mapped_column(String(300), default="")
    # provider-specific options, e.g. Azure: {"api_version": "...", "auth": "key|entra", "deployments": ["gpt-4o", ...]}
    extra_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class McpServer(RegistryBase):
    """A user-registered Model Context Protocol server that agents can be granted access to."""

    __tablename__ = "mcp_servers"
    __table_args__ = (UniqueConstraint("user_id", "name", name="uq_mcp_name"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    transport: Mapped[str] = mapped_column(String(10), default="stdio")
    command: Mapped[str] = mapped_column(String(300), default="")
    args_json: Mapped[list[str]] = mapped_column(JSON, default=list)
    url: Mapped[str] = mapped_column(String(500), default="")
    env_encrypted: Mapped[str] = mapped_column(Text, default="")  # Fernet-encrypted JSON
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    tools_json: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    last_error: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


# ====================================================================== project
class Company(ProjectBase):
    __tablename__ = "companies"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(36), index=True)  # registry user (cross-DB, no FK)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    canvas_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    agents: Mapped[list[Agent]] = relationship(back_populates="company", cascade="all, delete-orphan", lazy="selectin")
    edges: Mapped[list[Edge]] = relationship(back_populates="company", cascade="all, delete-orphan", lazy="selectin")


class Agent(ProjectBase):
    __tablename__ = "agents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(120), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    avatar: Mapped[str] = mapped_column(String(64), default="")
    color: Mapped[str] = mapped_column(String(16), default="#6366f1")
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(String(40), default="mock")
    model: Mapped[str] = mapped_column(String(120), default="mock/demo")
    temperature: Mapped[float] = mapped_column(Float, default=0.4)
    max_tokens: Mapped[int] = mapped_column(Integer, default=2048)
    tools_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    behavior_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    permission_level: Mapped[str] = mapped_column(String(20), default="inherit")  # inherit | read_only | plan | ask | danger
    is_entry: Mapped[bool] = mapped_column(Boolean, default=False)
    position_x: Mapped[float] = mapped_column(Float, default=0)
    position_y: Mapped[float] = mapped_column(Float, default=0)

    company: Mapped[Company] = relationship(back_populates="agents")


class Edge(ProjectBase):
    __tablename__ = "edges"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    source_agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    target_agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    bidirectional: Mapped[bool] = mapped_column(Boolean, default=False)
    type: Mapped[str] = mapped_column(String(20), default="delegate")
    label: Mapped[str] = mapped_column(String(200), default="")
    config_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    company: Mapped[Company] = relationship(back_populates="edges")


class ChatSession(ProjectBase):
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="New chat")
    mode: Mapped[str] = mapped_column(String(20), default="direct")  # direct | company
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Run(ProjectBase):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True)
    goal: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    mode: Mapped[str] = mapped_column(String(20), default="autonomous")
    permission_level: Mapped[str] = mapped_column(String(20), default="ask")
    budget_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    snapshot_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    state_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    turns: Mapped[int] = mapped_column(Integer, default=0)
    halt_reason: Mapped[str] = mapped_column(String(200), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    report_md: Mapped[str] = mapped_column(Text, default="")


class Message(ProjectBase):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), nullable=True, index=True)
    session_id: Mapped[str | None] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"), nullable=True, index=True)
    sender: Mapped[str] = mapped_column(String(10), default="agent")  # agent | user | system
    from_agent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    to_agent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    edge_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    type: Mapped[str] = mapped_column(String(30), default="answer")
    content: Mapped[str] = mapped_column(Text, default="")
    meta_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    turn_no: Mapped[int] = mapped_column(Integer, default=0)
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class RunEvent(ProjectBase):
    """Append-only event log used for WebSocket replay and timeline scrubbing."""

    __tablename__ = "run_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Task(ProjectBase):
    __tablename__ = "tasks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    assignee_agent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="todo")
    acceptance_criteria: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Artifact(ProjectBase):
    """Version history of files written by agents (content snapshot per version)."""

    __tablename__ = "artifacts"
    __table_args__ = (UniqueConstraint("run_id", "path", "version", name="uq_artifact_version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(500))
    content: Mapped[str] = mapped_column(Text, default="")
    previous_content: Mapped[str | None] = mapped_column(Text, nullable=True)  # file content before v1 (pre-existing file)
    version: Mapped[int] = mapped_column(Integer, default=1)
    planned: Mapped[bool] = mapped_column(Boolean, default=False)  # plan mode: written to the shadow dir, not the project
    author_agent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    change_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AgentMemory(ProjectBase):
    __tablename__ = "agent_memory"
    __table_args__ = (UniqueConstraint("agent_id", "key", name="uq_memory_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(200))
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


__all__ = [
    "PERMISSION_LEVELS", "User", "Workspace", "ProviderKey", "McpServer",
    "Company", "Agent", "Edge", "ChatSession", "Run", "Message", "RunEvent", "Task", "Artifact", "AgentMemory",
]
