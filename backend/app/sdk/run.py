"""The live run as plugins see it.

Tool handlers, workflows and model backends receive the run as their first argument. This protocol lists the members they
may rely on. The kernel's RunRuntime implements it; plugins never import that class. Members added by other plugins
(task board, workflow phases, file publishing...) are resolved through the host's run-method table, see ``RunContext.__getattr__``.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from pathlib import Path
from typing import Any, Protocol

from app.sdk.agents import AgentSpec
from app.sdk.plugin import Services
from app.sdk.routing import EdgeSpec


class RunContext(Protocol):
    # ---- identity and configuration
    services: Services
    run_id: str
    company_id: str
    user_id: str
    goal: str
    mode: str
    level: str                       # "ask" or "auto"
    root: Path
    sf: Any                          # project session factory
    budget: Any                      # RunBudget
    snapshot: dict[str, Any]
    snapshot_dirty: bool

    # ---- the team
    agents: dict[str, AgentSpec]
    edges: list[EdgeSpec]
    names: dict[str, str]
    roles: dict[str, Any]
    skills: dict[str, Any]
    lead_agent_id: str
    status: dict[str, str]
    activity: dict[str, str]
    done_agents: set[str]
    agent_turns: Counter[str]
    edge_counts: Counter[str]

    # ---- state the kernel keeps for the run
    turn_no: int
    history: list[dict[str, Any]]
    mailbox: dict[str, list[tuple[int, str]]]
    observations: dict[str, list[tuple[int, dict[str, Any]]]]
    tasks: dict[str, dict[str, Any]]
    artifacts: dict[str, dict[str, Any]]
    decisions: list[str]
    metrics: Counter[str]
    broken_files: dict[str, str]
    unverified: dict[str, int]
    debates: dict[str, Any]
    reviews: dict[str, Any]
    loop: Any                        # LoopDetector
    wf: dict[str, Any] | None        # the workflow's state; None = free-form run
    wake: asyncio.Event
    paused: bool
    awaiting: dict[str, Any] | None
    finished_summary: str | None
    runtime_store: Any
    execution: Any

    # ---- acting on the run
    async def emit(self, type_: str, data: dict[str, Any]) -> None: ...

    async def guard(self, agent: AgentSpec, kind: str, summary: str, preview: str, details: dict[str, Any] | None = None, *,
                    dangerous: bool = False) -> tuple[bool, str]:
        """The policy gate: ask the user (or auto-approve) before a gated action. Every action that changes something calls it."""

    async def deny(self, agent: AgentSpec, cid: str, tool: str, reason: str) -> None: ...

    async def _tool_event(self, agent: AgentSpec, tool: str, args: dict[str, Any]) -> str: ...

    async def _tool_result(self, agent: AgentSpec, cid: str, tool: str, ok: bool, output: str) -> None: ...

    def observe(self, agent_id: str, observation: dict[str, Any]) -> None: ...

    def notice(self, agent_id: str, text: str, *, activate: bool = False) -> None: ...

    async def set_agent_status(self, aid: str, status: str, activity: str = "") -> None: ...

    async def post_message(self, **kwargs: Any) -> Any: ...

    def resolve_agent(self, ref: str) -> AgentSpec | None: ...

    def log(self, agent_id: str, text: str) -> None: ...

    def decide(self, *args: Any, **kwargs: Any) -> None: ...

    def mark_work(self, agent_id: str) -> None: ...

    def mark_progress(self) -> None: ...

    def fs_for(self, aid: str) -> Any: ...

    def preview_url(self) -> str: ...

    def model_for(self, agent: AgentSpec) -> tuple[str, str]: ...

    def effort_for(self, agent: AgentSpec) -> str | None: ...

    def add_usage(self, agent_id: str, usage: Any) -> None: ...

    async def call_llm_escalating(self, agent: AgentSpec, req: Any) -> str: ...

    async def save(self) -> None: ...

    def db(self) -> Any: ...

    def file_lock(self, path: str) -> asyncio.Lock: ...

    def mutation_lock(self) -> asyncio.Lock: ...

    def __getattr__(self, name: str) -> Any:
        """Methods other plugins registered with ``HostApi.add_run_methods``. AttributeError when no enabled plugin has it."""
