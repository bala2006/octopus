"""Policy gate: every gated action asks here first. Approval cards and budget limits live here.

The gate reads its run through ``PolicyHost`` (level, mode, budget, status) and reports through the host's ``emit`` and status
methods. It imports nothing above core, so the run runtime injects itself as the host.

Approval events and payloads are part of the golden contract (``tests/golden/approval_cases.json`` and the run sequences).
Change this module only in ways those files still reproduce byte for byte.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Protocol

from app.db.base import new_id

# A run and all of its follow-ups may spend at most this multiple of the run's original budget (turns, tokens, cost, time).
FOLLOWUP_BUDGET_CEILING = 3


class BudgetLimits(Protocol):
    max_turns: int
    max_tokens: int
    max_cost_usd: float
    timeout_s: int


class PolicyHost(Protocol):
    """What the gate reads from its run, and where it reports approval events and status changes."""

    level: str
    mode: str
    budget: BudgetLimits
    status: dict[str, str]

    async def emit(self, type_: str, data: dict[str, Any]) -> None: ...

    async def set_run_status(self, status: str, reason: str = "") -> None: ...

    async def set_agent_status(self, aid: str, status: str, activity: str = "") -> None: ...


@dataclass(frozen=True)
class BudgetUsage:
    """Spend so far. ``active_seconds`` includes the turn in progress, so the time limit sees long turns while they run."""

    turns: int
    tokens: int
    cost: float
    active_seconds: float
    has_followups: bool


class PolicyGate:
    def __init__(self, host: PolicyHost) -> None:
        self.host = host
        self.approvals: dict[str, asyncio.Future[tuple[bool, str]]] = {}
        self.pending_approval: dict[str, Any] | None = None
        self.auto_approve: set[str] = set()  # "agent_id:kind" approved with scope=always
        self._approval_lock = asyncio.Lock()

    # ------------------------------------------------------------------ approvals
    async def decide(self, agent_id: str, kind: str, summary: str, preview: str, details: dict[str, Any] | None = None, *,
                     dangerous: bool = False) -> tuple[bool, str]:
        """Approval gate. "ask" asks for every gated action. "auto" (Approve for me) asks only for ``dangerous`` actions:
        dangerous edits and commands outside the project. Supervised runs still ask before writes and finishing.
        Returns (allowed, reason-if-denied)."""
        needs = self.host.level == "ask" or dangerous or (self.host.mode == "supervised" and kind in ("write_file", "finish"))
        if not needs:
            return True, ""
        ok, reason = await self.request_approval(agent_id, kind, summary, preview, details)
        return ok, ("" if ok else f"The user REJECTED {kind}: {reason or 'no reason given'}")

    async def request_approval(self, agent_id: str, kind: str, summary: str, preview: str,
                               details: dict[str, Any] | None = None) -> tuple[bool, str]:
        if f"{agent_id}:{kind}" in self.auto_approve:
            await self.host.emit("approval_resolved", {"id": None, "approved": True, "reason": "auto-approved (always allow)",
                                                       "agent_id": agent_id, "kind": kind, "summary": summary, "auto": True})
            return True, "auto"
        async with self._approval_lock:  # one approval card at a time, even when delegated teammates work in parallel
            return await self._request_approval(agent_id, kind, summary, preview, details)

    async def _request_approval(self, agent_id: str, kind: str, summary: str, preview: str,
                                details: dict[str, Any] | None = None) -> tuple[bool, str]:
        if f"{agent_id}:{kind}" in self.auto_approve:  # an earlier card in the queue may have said "always"
            return True, "auto"
        aid = new_id()
        fut: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self.approvals[aid] = fut
        self.pending_approval = {"id": aid, "agent_id": agent_id, "kind": kind, "summary": summary, "preview": preview[:6000],
                                 "details": details or {}, "level": self.host.level}
        prev_status = self.host.status.get(agent_id, "idle")
        await self.host.set_agent_status(agent_id, "awaiting_approval", summary)
        await self.host.emit("approval_requested", self.pending_approval)
        await self.host.set_run_status("awaiting_user", f"Approval needed: {summary}"[:200])
        try:
            approved, reason = await fut
        finally:
            self.approvals.pop(aid, None)
            self.pending_approval = None
        await self.host.emit("approval_resolved", {"id": aid, "approved": approved, "reason": reason, "agent_id": agent_id,
                                                   "kind": kind, "summary": summary})
        await self.host.set_run_status("running")
        await self.host.set_agent_status(agent_id, prev_status if prev_status != "awaiting_approval" else "thinking")
        return approved, reason

    def resolve(self, approval_id: str, approved: bool, reason: str, scope: str = "once") -> bool:
        fut = self.approvals.get(approval_id)
        if fut and not fut.done():
            if approved and scope == "always" and self.pending_approval:
                self.auto_approve.add(f"{self.pending_approval['agent_id']}:{self.pending_approval['kind']}")
            fut.set_result((approved, reason))
            return True
        return False

    def supersede(self, reason: str) -> None:
        """User steering: every open card is answered "no" so the run can re-plan."""
        for future in self.approvals.values():
            if not future.done():
                future.set_result((False, reason))

    def cancel_pending(self) -> None:
        """Kill switch: open cards are cancelled."""
        for future in self.approvals.values():
            if not future.done():
                future.cancel()

    # ------------------------------------------------------------------ budget
    def budget_reason(self, usage: BudgetUsage, *, turns: bool = True) -> str | None:
        """``turns=False`` inside a turn's tool loop: the turn is already counted, only spend and time can run out."""
        b = self.host.budget
        reason = None
        if turns and usage.turns >= b.max_turns:
            reason = f"Budget: max turns reached ({b.max_turns})"
        elif usage.tokens >= b.max_tokens:
            reason = f"Budget: token budget exhausted ({usage.tokens}/{b.max_tokens})"
        elif b.max_cost_usd > 0 and usage.cost >= b.max_cost_usd:
            reason = f"Budget: cost budget exhausted (${usage.cost:.4f}/${b.max_cost_usd:.2f})"
        elif usage.active_seconds >= b.timeout_s:  # time spent working; paused / waiting-for-you time is not counted
            reason = f"Budget: active-time limit reached ({b.timeout_s}s of agent work)"
        if reason and usage.has_followups:
            reason += f"; follow-ups share a lifetime ceiling of {FOLLOWUP_BUDGET_CEILING}x the run budget, start a new run to go further"
        return reason
