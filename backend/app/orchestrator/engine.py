"""The Octopus orchestration runtime.

One ``RunRuntime`` per run executes as an asyncio task:

    pick next runnable agent (FIFO over mailbox + activating observations)
      → build prompt (system prompt + meta rules + roster + channels + blackboard + summary + inbox)
      → stream LLM call (token_stream events)
      → parse structured actions → execute (permissions, protocols, limits enforced here)
      → route messages to mailboxes → persist + publish events → repeat

Bounded by: global max turns, per-edge max turns, token + cost budget, active wall-clock timeout,
per-agent max autonomous turns, loop detector (auto-pause on repeated strikes), human pause and kill switch.
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select, update

from app.core.config import PROJECT_DIRNAME, get_settings
from app.core.logging import get_logger
from app.db.base import new_id, utcnow
from app.db.session import SessionFactory, registry_factory
from app.llm.base import LLMError, LLMRequest
from app.llm.demo_script import role_category
from app.llm.router import prepare_request, stream_with_retry
from app.models import AgentMemory, Artifact, Message, Run, Task
from app.orchestrator import actions as A
from app.orchestrator.bus import bus
from app.orchestrator.context import AgentSpec, build_system_prompt, build_user_prompt
from app.orchestrator.permissions import EdgeSpec, allowed_recipients, find_channel, rejection_reason
from app.orchestrator.protocols import (
    DebateState, LoopDetector, ReviewState, debate_decided_externally, debate_on_message, infer_verdict,
    review_on_request, review_on_result,
)
from app.schemas import RunBudget
from app.tools import basic
from app.tools.sandbox import SandboxError, parse_command, run_command
from app.tools.workspace import ProjectFS, WorkspaceError

log = get_logger("orchestrator")

DEBATE_PROTOCOL_TYPES = {"proposal", "critique", "objection", "agreement", "decision"}
ACTIVE_STATES = {"queued", "running", "paused", "awaiting_user"}


LEVEL_ORDER = {"read_only": 0, "plan": 1, "ask": 2, "danger": 3}
LEVEL_LABEL = {"read_only": "read-only", "plan": "plan", "ask": "ask", "danger": "danger"}
DANGEROUS = {"write_file", "run_code", "mcp_call"}


class StopRun(Exception):
    pass


@dataclass
class ProjectRef:
    """Where a run lives: the project directory and its .octopus database."""

    workspace_id: str
    root: Path
    sf: SessionFactory


def effective_level(run_level: str, agent_level: str | None) -> str:
    """The run's level caps everything; an agent override can only be *more* restrictive."""
    run_level = run_level if run_level in LEVEL_ORDER else "ask"
    if not agent_level or agent_level == "inherit" or agent_level not in LEVEL_ORDER:
        return run_level
    return min(run_level, agent_level, key=LEVEL_ORDER.__getitem__)


_ACTION_RE = re.compile(r'"action"\s*:\s*"(\w+)"')
_FIELD_RE = {f: re.compile(rf'"{f}"\s*:\s*"((?:[^"\\]|\\.)*)') for f in ("to", "type", "path", "command", "server", "tool", "question")}


def live_activity(text: str) -> tuple[str, str]:
    """Infer what an agent is doing *while* its reply streams (for realtime UI feedback)."""
    matches = list(_ACTION_RE.finditer(text))
    if not matches:
        return ("thinking", "Reasoning…")
    m = matches[-1]
    tail = text[m.end():]
    get = lambda f: (_FIELD_RE[f].search(tail).group(1) if _FIELD_RE[f].search(tail) else "")  # noqa: E731
    act = m.group(1)
    if act == "send_message":
        to, typ = get("to"), get("type").replace("_", " ")
        return ("speaking", f"Drafting {typ or 'message'}{' to ' + to if to else ''}…")
    if act == "write_file":
        return ("writing", f"Writing {get('path') or 'a file'}…")
    if act in ("read_file", "list_files"):
        return ("reading", f"Reading {get('path') or 'the project'}…")
    if act == "run_code":
        return ("running", f"Preparing `{get('command')[:60]}`…" if get("command") else "Preparing a command…")
    if act == "mcp_call":
        return ("tool", f"Preparing {get('server')}/{get('tool')}…")
    if act == "update_task_board":
        return ("thinking", "Updating the task board…")
    if act == "request_user_input":
        return ("speaking", "Writing a question for you…")
    if act == "finish":
        return ("thinking", "Wrapping up…")
    return ("thinking", "Planning next step…")


class RunRuntime:
    def __init__(self, run: Run, user_id: str, project: ProjectRef) -> None:
        snap = run.snapshot_json or {}
        self.project = project
        self.sf = project.sf
        self.level = run.permission_level or "ask"
        self.run_id = run.id
        self.session_id = run.session_id
        self.user_id = user_id
        self.goal = run.goal
        self.mode = run.mode
        self.budget = RunBudget(**(run.budget_json or {}))
        self.company_name = (snap.get("company") or {}).get("name", "Company")
        self.agents: dict[str, AgentSpec] = {}
        for a in snap.get("agents", []):
            cat = role_category(a.get("role", ""), (a.get("behavior") or {}).get("template_key", ""))
            self.agents[a["id"]] = AgentSpec.from_dict(a, cat)
        self.edges = [EdgeSpec.from_dict(e) for e in snap.get("edges", [])]
        self.names = {a.id: a.name for a in self.agents.values()}
        self.attachments: list[dict[str, str]] = (run.state_json or {}).get("attachments", [])

        self.history: list[dict[str, Any]] = []
        self.mailbox: dict[str, list[tuple[int, str]]] = {}
        self.observations: dict[str, list[tuple[int, dict[str, Any]]]] = {}
        self.status: dict[str, str] = {aid: "idle" for aid in self.agents}
        self.done_agents: set[str] = set()
        self.agent_turns: Counter[str] = Counter()
        self.agent_tokens: Counter[str] = Counter()
        self.edge_counts: Counter[str] = Counter()
        self.debates: dict[str, DebateState] = {}
        self.reviews: dict[str, ReviewState] = {}
        self.loop = LoopDetector(threshold=self.budget.loop_threshold, max_strikes=self.budget.max_loop_strikes)
        self.loop_escalated = False
        self.tasks: dict[str, dict[str, Any]] = {}
        self.task_counter = 0
        self.artifacts: dict[str, dict[str, Any]] = {}
        self.decisions: list[str] = []
        self.user_notes: list[str] = []
        self.mock_state: dict[str, dict[str, Any]] = {}
        self.warned: set[str] = set()
        self.rejections = 0

        self.seq = 0
        self.turn_no = run.turns or 0
        self.tokens = run.tokens_used or 0
        self.cost = run.cost_usd or 0.0
        self.active_seconds = 0.0
        self.run_status = run.status

        self.wake = asyncio.Event()
        self.paused = False
        self.step_credits = 0
        self.stop_requested = False
        self.awaiting: dict[str, Any] | None = None
        self.approvals: dict[str, asyncio.Future[tuple[bool, str]]] = {}
        self.pending_approval: dict[str, Any] | None = None
        self.finished_summary: str | None = None
        self.finalized = False
        self.task: asyncio.Task[None] | None = None
        self.root = project.root
        self._fs: dict[tuple[bool, bool], ProjectFS] = {}
        self.mcp_configs: dict[str, Any] = {}
        self.auto_approve: set[str] = set()  # "agent_id:kind" approved with scope=always
        self.activity: dict[str, str] = {}
        agent_levels = {a["id"]: a.get("permission_level") for a in snap.get("agents", [])}
        self.levels = {aid: effective_level(self.level, agent_levels.get(aid)) for aid in self.agents}

    # ------------------------------------------------------------------ persistence helpers
    def db(self):  # type: ignore[no-untyped-def]
        return self.sf()

    def fs_for(self, aid: str) -> ProjectFS:
        level = self.levels.get(aid, self.level)
        key = (level == "plan", level == "danger")
        if key not in self._fs:
            shadow = self.root / PROJECT_DIRNAME / "plans" / self.run_id if key[0] else None
            self._fs[key] = ProjectFS(self.root, shadow=shadow, allow_secrets=key[1])
        return self._fs[key]

    async def emit(self, type_: str, data: dict[str, Any]) -> None:
        await bus.publish(self.run_id, type_, data, self.sf)

    def state_dict(self) -> dict[str, Any]:
        return {
            "attachments": self.attachments,
            "observations": {k: [o for _, o in v] for k, v in self.observations.items()},
            "status": self.status, "done_agents": sorted(self.done_agents),
            "agent_turns": dict(self.agent_turns), "agent_tokens": dict(self.agent_tokens), "edge_counts": dict(self.edge_counts),
            "debates": {k: v.to_dict() for k, v in self.debates.items()},
            "reviews": {k: v.to_dict() for k, v in self.reviews.items()},
            "loop": self.loop.to_dict(), "task_counter": self.task_counter,
            "decisions": self.decisions, "user_notes": self.user_notes, "mock_state": self.mock_state,
            "active_seconds": round(self.active_seconds, 2), "awaiting": self.awaiting,
            "pending_approval": self.pending_approval, "rejections": self.rejections,
            "auto_approve": sorted(self.auto_approve), "levels": self.levels, "activity": self.activity,
        }

    async def save(self) -> None:
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(
                tokens_used=self.tokens, cost_usd=round(self.cost, 6), turns=self.turn_no, state_json=self.state_dict()))
            await db.commit()

    async def restore(self, run: Run) -> None:
        st = run.state_json or {}
        self.status.update(st.get("status", {}))
        self.done_agents = set(st.get("done_agents", []))
        self.agent_turns = Counter(st.get("agent_turns", {}))
        self.agent_tokens = Counter(st.get("agent_tokens", {}))
        self.edge_counts = Counter(st.get("edge_counts", {}))
        self.debates = {k: DebateState.from_dict(v) for k, v in st.get("debates", {}).items()}
        self.reviews = {k: ReviewState.from_dict(v) for k, v in st.get("reviews", {}).items()}
        if st.get("loop"):
            self.loop = LoopDetector.from_dict(st["loop"])
        self.task_counter = st.get("task_counter", 0)
        self.decisions, self.user_notes = st.get("decisions", []), st.get("user_notes", [])
        self.mock_state = st.get("mock_state", {})
        self.active_seconds = float(st.get("active_seconds", 0))
        self.awaiting = st.get("awaiting")
        self.rejections = st.get("rejections", 0)
        self.auto_approve = set(st.get("auto_approve", []))
        async with self.db() as db:
            msgs = (await db.execute(select(Message).where(Message.run_id == self.run_id).order_by(Message.created_at))).scalars().all()
            for m in msgs:
                rec = self._rec(m)
                self.history.append(rec)
                if not m.read and m.to_agent_id in self.agents:
                    self.seq += 1
                    self.mailbox.setdefault(m.to_agent_id, []).append((self.seq, m.id))
            for t in (await db.execute(select(Task).where(Task.run_id == self.run_id))).scalars().all():
                self.tasks[t.key] = self._task_dict(t)
            for a in (await db.execute(select(Artifact).where(Artifact.run_id == self.run_id).order_by(Artifact.version))).scalars().all():
                self.artifacts[a.path] = {"version": a.version, "author": a.author_agent_id, "note": a.change_note}
        for aid, obs in st.get("observations", {}).items():
            for o in obs:
                self.seq += 1
                self.observations.setdefault(aid, []).append((self.seq, o))
        await self._load_memory()

    async def _load_memory(self) -> None:
        async with self.db() as db:
            rows = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id.in_(list(self.agents))))).scalars().all()
        for r in rows:
            self.agents[r.agent_id].memory[r.key] = r.value

    @staticmethod
    def _rec(m: Message) -> dict[str, Any]:
        return {"id": m.id, "from": m.from_agent_id, "to": m.to_agent_id, "type": m.type, "content": m.content,
                "turn": m.turn_no, "edge_id": m.edge_id, "meta": m.meta_json or {}, "sender": m.sender}

    @staticmethod
    def _task_dict(t: Task) -> dict[str, Any]:
        return {"id": t.id, "key": t.key, "title": t.title, "description": t.description, "assignee": t.assignee_agent_id,
                "status": t.status, "acceptance_criteria": t.acceptance_criteria, "created_by": t.created_by}

    # ------------------------------------------------------------------ status
    async def set_run_status(self, status: str, reason: str = "") -> None:
        if status == self.run_status and not reason:
            return
        self.run_status = status
        values: dict[str, Any] = {"status": status}
        if reason:
            values["halt_reason"] = reason[:200]
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(**values))
            await db.commit()
        await self.emit("run_status", {"status": status, "reason": reason, "awaiting": self.awaiting,
                                       "pending_approval": self.pending_approval})

    async def set_agent_status(self, aid: str, status: str, activity: str = "") -> None:
        if self.status.get(aid) != status or self.activity.get(aid, "") != activity:
            self.status[aid] = status
            self.activity[aid] = activity
            await self.emit("agent_status", {"agent_id": aid, "status": status, "activity": activity})

    async def usage_event(self) -> None:
        await self.emit("usage_update", {
            "tokens": self.tokens, "cost_usd": round(self.cost, 6), "turns": self.turn_no,
            "max_turns": self.budget.max_turns, "max_tokens": self.budget.max_tokens, "max_cost_usd": self.budget.max_cost_usd,
            "per_agent": dict(self.agent_tokens), "active_seconds": round(self.active_seconds, 1), "timeout_s": self.budget.timeout_s,
        })

    # ------------------------------------------------------------------ messaging primitives
    def deliver(self, aid: str, mid: str) -> None:
        self.seq += 1
        self.mailbox.setdefault(aid, []).append((self.seq, mid))

    def observe(self, aid: str, obs: dict[str, Any], *, activate: bool = True) -> None:
        self.seq += 1
        obs = {**obs, "activate": activate}
        self.observations.setdefault(aid, []).append((self.seq, obs))

    def notice(self, aid: str, text: str, *, activate: bool = False) -> None:
        self.observe(aid, {"tool": "system", "content": text}, activate=activate)

    async def post_message(self, *, sender: str, from_id: str | None, to_id: str | None, type_: str, content: str,
                           edge_id: str | None = None, meta: dict[str, Any] | None = None, deliver: bool = True) -> dict[str, Any]:
        m = Message(id=new_id(), run_id=self.run_id, session_id=self.session_id, sender=sender, from_agent_id=from_id,
                    to_agent_id=to_id, edge_id=edge_id, type=type_, content=content, meta_json=meta or {},
                    turn_no=self.turn_no, read=not (deliver and to_id in self.agents), created_at=utcnow())
        async with self.db() as db:
            db.add(m)
            await db.commit()
        rec = self._rec(m)
        self.history.append(rec)
        if deliver and to_id in self.agents:
            self.deliver(to_id, m.id)
            if to_id in self.done_agents:
                self.done_agents.discard(to_id)
            if self.status.get(to_id) in ("idle", "done"):
                await self.set_agent_status(to_id, "waiting")
        await self.emit("message_created", {"message": {
            "id": m.id, "run_id": m.run_id, "session_id": m.session_id, "sender": sender, "from_agent_id": from_id,
            "to_agent_id": to_id, "edge_id": edge_id, "type": type_, "content": content, "meta": m.meta_json,
            "turn_no": m.turn_no, "created_at": m.created_at.isoformat()}})
        return rec

    def next_runnable(self) -> str | None:
        best: tuple[int, str] | None = None
        for aid in self.agents:
            seqs = [s for s, _ in self.mailbox.get(aid, [])] + [s for s, o in self.observations.get(aid, []) if o.get("activate")]
            if seqs:
                s = min(seqs)
                if best is None or s < best[0]:
                    best = (s, aid)
        return best[1] if best else None

    def resolve_agent(self, name: str) -> str | None:
        n = name.strip().lower().lstrip("@")
        for aid, a in self.agents.items():
            if a.name.lower() == n or aid == name:
                return aid
        for aid, a in self.agents.items():
            if a.role.lower() == n:
                return aid
        for aid, a in self.agents.items():
            if a.name.lower().startswith(n) or n.startswith(a.name.lower()):
                return aid
        return None

    # ------------------------------------------------------------------ limits & control
    def limit_reason(self) -> str | None:
        b = self.budget
        if self.turn_no >= b.max_turns:
            return f"Budget: max turns reached ({b.max_turns})"
        if self.tokens >= b.max_tokens:
            return f"Budget: token budget exhausted ({self.tokens}/{b.max_tokens})"
        if b.max_cost_usd > 0 and self.cost >= b.max_cost_usd:
            return f"Budget: cost budget exhausted (${self.cost:.4f}/${b.max_cost_usd:.2f})"
        if self.active_seconds >= b.timeout_s:
            return f"Budget: wall-clock timeout ({b.timeout_s}s)"
        return None

    async def gate(self) -> None:
        while True:
            self.wake.clear()
            if self.stop_requested:
                raise StopRun()
            if self.awaiting:
                await self.set_run_status("awaiting_user")
            elif self.paused:
                await self.set_run_status("paused")
            elif self.mode == "step" and self.step_credits <= 0:
                await self.set_run_status("paused", "Step mode: press Next turn")
            else:
                break
            await self.wake.wait()
        if self.mode == "step":
            self.step_credits -= 1
        await self.set_run_status("running")

    def pause(self) -> None:
        self.paused = True
        self.wake.set()

    def resume(self) -> None:
        self.paused = False
        self.loop.strikes = {}
        self.loop_escalated = False
        if self.mode == "step":
            self.step_credits = max(self.step_credits, 1)
        self.wake.set()

    def step(self) -> None:
        self.paused = False
        self.step_credits += 1
        self.wake.set()

    def stop(self) -> None:
        self.stop_requested = True
        self.wake.set()
        for f in self.approvals.values():
            if not f.done():
                f.cancel()
        if self.task and not self.task.done():
            self.task.cancel()

    async def interject(self, content: str, to_agent_id: str | None) -> None:
        targets = [to_agent_id] if to_agent_id else list(self.agents)
        self.user_notes.append(content[:300])
        for t in targets:
            if t in self.agents:
                await self.post_message(sender="user", from_id=None, to_id=t, type_="user_interjection", content=content)
        if self.awaiting and (to_agent_id is None or to_agent_id == self.awaiting.get("agent_id")):
            self.awaiting = None
        self.wake.set()

    def resolve_approval(self, approval_id: str, approved: bool, reason: str, scope: str = "once") -> bool:
        fut = self.approvals.get(approval_id)
        if fut and not fut.done():
            if approved and scope == "always" and self.pending_approval:
                self.auto_approve.add(f"{self.pending_approval['agent_id']}:{self.pending_approval['kind']}")
            fut.set_result((approved, reason))
            return True
        return False

    async def request_approval(self, agent: AgentSpec, kind: str, summary: str, preview: str,
                               details: dict[str, Any] | None = None) -> tuple[bool, str]:
        if f"{agent.id}:{kind}" in self.auto_approve:
            await self.emit("approval_resolved", {"id": None, "approved": True, "reason": "auto-approved (always allow)",
                                                  "agent_id": agent.id, "kind": kind, "summary": summary, "auto": True})
            return True, "auto"
        aid = new_id()
        fut: asyncio.Future[tuple[bool, str]] = asyncio.get_running_loop().create_future()
        self.approvals[aid] = fut
        self.pending_approval = {"id": aid, "agent_id": agent.id, "kind": kind, "summary": summary, "preview": preview[:6000],
                                 "details": details or {}, "level": self.levels.get(agent.id, self.level)}
        prev_status = self.status.get(agent.id, "idle")
        await self.set_agent_status(agent.id, "awaiting_approval", summary)
        await self.emit("approval_requested", self.pending_approval)
        await self.set_run_status("awaiting_user", f"Approval needed: {summary}"[:200])
        try:
            approved, reason = await fut
        finally:
            self.approvals.pop(aid, None)
            self.pending_approval = None
        await self.emit("approval_resolved", {"id": aid, "approved": approved, "reason": reason, "agent_id": agent.id,
                                              "kind": kind, "summary": summary})
        await self.set_run_status("running")
        await self.set_agent_status(agent.id, prev_status if prev_status != "awaiting_approval" else "thinking")
        return approved, reason

    async def guard(self, agent: AgentSpec, kind: str, summary: str, preview: str, details: dict[str, Any] | None = None) -> tuple[bool, str]:
        """Permission gate for dangerous actions. Returns (allowed, reason-if-denied)."""
        level = self.levels.get(agent.id, self.level)
        if level == "read_only":
            return False, f"Your permission level is read-only: {kind} is not allowed. Describe the change instead."
        if level == "plan":
            if kind == "write_file":
                return True, ""  # goes to the plan shadow directory
            return False, f"Plan mode: {kind} is not allowed. Write your proposed changes with write_file (they are saved as a plan)."
        needs = level == "ask" or (self.mode == "supervised" and kind in ("write_file", "finish"))
        if not needs:
            return True, ""
        ok, reason = await self.request_approval(agent, kind, summary, preview, details)
        return ok, ("" if ok else f"The user REJECTED {kind}: {reason or 'no reason given'}")

    # ------------------------------------------------------------------ main loop
    def entry_agents(self) -> list[str]:
        entries = [a.id for a in self.agents.values() if a.is_entry]
        if entries:
            return entries
        targets = {e.target for e in self.edges} | {e.source for e in self.edges if e.bidirectional}
        roots = [aid for aid in self.agents if aid not in targets]
        return roots[:1] or list(self.agents)[:1]

    async def bootstrap(self) -> None:
        content = self.goal
        for att in self.attachments:
            content += f"\n\n--- Attached file: {att.get('filename', 'file')} ---\n{att.get('text', '')[:20000]}"
        for aid in self.entry_agents():
            await self.post_message(sender="user", from_id=None, to_id=aid, type_="task", content=content, meta={"goal": True})

    async def main(self, fresh: bool = True) -> None:
        try:
            if not self.agents:
                await self.finalize("failed", "The company has no agents")
                return
            async with self.db() as db:
                await db.execute(update(Run).where(Run.id == self.run_id, Run.started_at.is_(None)).values(started_at=utcnow()))
                await db.commit()
            if fresh:
                await self.set_run_status("running")
                await self.bootstrap()
            while True:
                reason = self.limit_reason()
                if reason:
                    await self.emit("error", {"message": reason, "kind": "limit"})
                    await self.finalize("failed", reason)
                    return
                await self.gate()
                aid = self.next_runnable()
                if aid is None:
                    if self.awaiting:
                        continue
                    await self.finalize("completed", "Run went quiescent: no agent has pending work")
                    return
                t0 = time.monotonic()
                try:
                    await self.turn(aid)
                finally:
                    self.active_seconds += time.monotonic() - t0
                await self.save()
                await self.usage_event()
                if self.finished_summary is not None:
                    await self.finalize("completed", "")
                    return
                if self.loop.escalate() and not self.loop_escalated:
                    self.loop_escalated = True
                    self.paused = True
                    await self.emit("error", {"message": "Loop detected: agents keep sending near-identical messages. "
                                                         "Run paused for human review; interject to steer, then resume.", "kind": "loop"})
        except (StopRun, asyncio.CancelledError):
            await asyncio.shield(self.finalize("cancelled", "Stopped by user (kill switch)"))
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("run_failed", run_id=self.run_id)
            await asyncio.shield(self.finalize("failed", f"{type(exc).__name__}: {exc}"))

    # ------------------------------------------------------------------ a single agent turn
    def blackboard(self) -> str:
        lines = [f"Goal: {self.goal[:1500]}"]
        if self.decisions:
            lines.append("Decisions:\n" + "\n".join(f"- {d}" for d in self.decisions[-10:]))
        if self.debates:
            lines.append("Debates:\n" + "\n".join(
                f"- {' ↔ '.join(self.names.get(p, p) for p in d.participants)}: {d.status} (round {d.rounds}/{d.max_rounds}) {d.topic}"
                for d in self.debates.values()))
        if self.reviews:
            lines.append("Reviews:\n" + "\n".join(
                f"- {self.names.get(r.author, '?')} → {self.names.get(r.reviewer, '?')}: {r.status} (revisions {r.revisions}/{r.max_revisions})"
                for r in self.reviews.values()))
        if self.tasks:
            lines.append("Task board:\n" + "\n".join(
                f"- {t['key']} [{t['status']}] {t['title']} (assignee: {self.names.get(t['assignee'] or '', 'unassigned')})"
                for t in self.tasks.values()))
        if self.artifacts:
            lines.append("Workspace files:\n" + "\n".join(
                f"- {p} v{a['version']} by {self.names.get(a['author'] or '', '?')}" for p, a in sorted(self.artifacts.items())))
        if self.user_notes:
            lines.append("User notes:\n" + "\n".join(f"- {n}" for n in self.user_notes[-5:]))
        lines.append(f"Budget: turn {self.turn_no}/{self.budget.max_turns}, tokens {self.tokens}/{self.budget.max_tokens}")
        return "\n".join(lines)

    def mock_context(self, agent: AgentSpec, inbox: list[dict[str, Any]], obs: list[dict[str, Any]]) -> dict[str, Any]:
        allowed = allowed_recipients(self.edges, agent.id)
        cat = lambda aid: self.agents[aid].category if aid in self.agents else "user"  # noqa: E731
        return {
            "agent": {"id": agent.id, "name": agent.name, "role": agent.role, "category": agent.category, "is_entry": agent.is_entry},
            "goal": self.goal,
            "inbox": [{"from": "user" if m["from"] is None else self.names.get(m["from"], "?"),
                       "from_category": "user" if m["from"] is None else cat(m["from"]),
                       "type": m["type"], "content": m["content"], "verdict": m["meta"].get("verdict"),
                       "comments": m["meta"].get("comments", [])} for m in inbox],
            "observations": obs,
            "allowed": [{"name": self.names[r], "role": self.agents[r].role, "category": self.agents[r].category,
                         "edge_types": [e.type for e in es]} for r, es in allowed.items()],
            "roster": [{"name": a.name, "role": a.role, "category": a.category} for a in self.agents.values()],
            "tasks": [{"key": t["key"], "title": t["title"], "assignee": self.names.get(t["assignee"] or "", None), "status": t["status"]}
                      for t in self.tasks.values()],
            "state": self.mock_state.setdefault(agent.id, {}),
        }

    async def call_llm(self, agent: AgentSpec, req: LLMRequest) -> str:
        parts: list[str] = []
        buf, last = "", time.monotonic()
        speaking = False
        remaining = max(5.0, self.budget.timeout_s - self.active_seconds)

        async def consume() -> None:
            nonlocal buf, last, speaking
            async for chunk in stream_with_retry(req):
                if chunk.delta:
                    parts.append(chunk.delta)
                    buf += chunk.delta
                    if not speaking or len(buf) >= 80 or time.monotonic() - last > 0.06:
                        speaking = True
                        status, activity = live_activity("".join(parts))
                        await self.set_agent_status(agent.id, status, activity)
                        await self.emit("token_stream", {"agent_id": agent.id, "delta": buf, "turn_no": self.turn_no})
                        buf, last = "", time.monotonic()
                if chunk.usage:
                    u = chunk.usage
                    self.tokens += u.total_tokens
                    self.cost += u.cost_usd
                    self.agent_tokens[agent.id] += u.total_tokens
            if buf:
                await self.emit("token_stream", {"agent_id": agent.id, "delta": buf, "turn_no": self.turn_no})

        await asyncio.wait_for(consume(), timeout=min(remaining, 300))
        return "".join(parts)

    async def turn(self, aid: str) -> None:
        agent = self.agents[aid]
        inbox_ids = [mid for _, mid in self.mailbox.pop(aid, [])]
        obs = [o for _, o in self.observations.pop(aid, [])]
        self.turn_no += 1
        self.agent_turns[aid] += 1
        if inbox_ids:
            async with self.db() as db:
                await db.execute(update(Message).where(Message.id.in_(inbox_ids)).values(read=True))
                await db.commit()
        max_auto = int(agent.behavior.get("max_autonomous_turns", 12))
        if self.agent_turns[aid] > max_auto:
            await self.emit("error", {"message": f"{agent.name} exceeded max autonomous turns ({max_auto}); its pending work was dropped.",
                                      "agent_id": aid, "kind": "limit"})
            self.done_agents.add(aid)
            await self.set_agent_status(aid, "done")
            return
        await self.emit("turn_started", {"agent_id": aid, "turn_no": self.turn_no, "inbox": inbox_ids})
        await self.set_agent_status(aid, "thinking", f"Reading {len(inbox_ids)} new message(s)…" if inbox_ids else "Reviewing results…")
        inbox_set = set(inbox_ids)
        inbox = [m for m in self.history if m["id"] in inbox_set]
        system = build_system_prompt(agent, company=self.company_name, goal=self.goal, agents=self.agents, edges=self.edges)
        user = build_user_prompt(agent=agent, history=self.history, inbox_ids=inbox_set, observations=obs,
                                 blackboard=self.blackboard(), names=self.names, recent_n=self.budget.context_recent)
        req = LLMRequest(provider=agent.provider, model=agent.model, temperature=agent.temperature, max_tokens=agent.max_tokens,
                         messages=[{"role": "system", "content": system}, {"role": "user", "content": user}], json_mode=True,
                         metadata={"kind": "orchestrator", "mock_context": self.mock_context(agent, inbox, obs)})
        if self.budget.force_mock:
            req.provider, req.model = "mock", "mock/demo"
        try:
            async with registry_factory()() as rdb:
                req, warn = await prepare_request(rdb, self.user_id, req)
            if warn and aid not in self.warned:
                self.warned.add(aid)
                await self.emit("error", {"message": f"{agent.name}: {warn}", "agent_id": aid, "kind": "warning"})
            text = await self.call_llm(agent, req)
            parsed = A.parse_envelope(text)
            if not parsed.ok and req.provider != "mock":
                req.messages += [{"role": "assistant", "content": text[:4000]},
                                 {"role": "user", "content": "Your reply was not valid per the response format ("
                                  + "; ".join(parsed.errors) + "). Reply again with ONLY the JSON object."}]
                text = await self.call_llm(agent, req)
                parsed = A.parse_envelope(text)
        except (LLMError, asyncio.TimeoutError) as exc:
            await self.set_agent_status(aid, "error")
            await self.emit("error", {"message": f"{agent.name}: LLM call failed: {exc}", "agent_id": aid, "kind": "llm"})
            self.notice(aid, f"Your previous turn failed due to a model error ({exc}). Try again concisely.", activate=bool(inbox_ids))
            return
        if not parsed.ok:
            await self.set_agent_status(aid, "error")
            await self.emit("error", {"message": f"{agent.name} produced an invalid response: {'; '.join(parsed.errors)}", "agent_id": aid, "kind": "parse"})
            self.notice(aid, "Your last reply could not be parsed: " + "; ".join(parsed.errors) + ". Reply with the JSON object only.", activate=True)
            return
        if parsed.thought:
            await self.emit("thought", {"agent_id": aid, "text": parsed.thought, "turn_no": self.turn_no})
        for err in parsed.errors:
            self.notice(aid, f"Ignored invalid action: {err}", activate=False)
        for action in parsed.actions:
            if self.stop_requested:
                raise StopRun()
            await self.execute(agent, action)
            if self.finished_summary is not None:
                break
        if aid in self.done_agents:
            await self.set_agent_status(aid, "done", "Finished")
        elif self.mailbox.get(aid):
            await self.set_agent_status(aid, "waiting", f"{len(self.mailbox[aid])} message(s) queued")
        elif self.awaiting and self.awaiting.get("agent_id") == aid:
            await self.set_agent_status(aid, "waiting", "Waiting for your answer")
        else:
            await self.set_agent_status(aid, "idle", "Waiting for messages")

    # ------------------------------------------------------------------ action execution
    async def execute(self, agent: AgentSpec, action: Any) -> None:
        name = action.action
        tool = A.ACTION_TOOL.get(name)
        if tool and not A.tool_enabled(agent.tools, tool):
            self.notice(agent.id, f"Action '{name}' is not available to you (tool '{tool}' disabled).", activate=True)
            await self.emit("error", {"message": f"{agent.name} tried disabled tool {tool}", "agent_id": agent.id, "kind": "permission"})
            return
        handler = getattr(self, f"act_{name}")
        await handler(agent, action)

    async def deny(self, agent: AgentSpec, cid: str, tool: str, reason: str) -> None:
        self.notice(agent.id, reason, activate=True)
        await self._tool_result(agent, cid, tool, False, reason)
        await self.emit("error", {"message": f"{agent.name}: {reason}", "agent_id": agent.id, "kind": "permission"})

    async def _tool_event(self, agent: AgentSpec, tool: str, args: dict[str, Any]) -> str:
        cid = new_id()
        await self.emit("tool_call", {"call_id": cid, "agent_id": agent.id, "tool": tool, "args": args, "turn_no": self.turn_no})
        return cid

    async def _tool_result(self, agent: AgentSpec, cid: str, tool: str, ok: bool, output: str) -> None:
        await self.emit("tool_result", {"call_id": cid, "agent_id": agent.id, "tool": tool, "ok": ok, "output": output[:4000]})

    async def reject(self, agent: AgentSpec, to_id: str | None, a: A.SendMessage, reason: str) -> None:
        self.rejections += 1
        self.notice(agent.id, f"Message to {self.names.get(to_id or '', a.to)} was REJECTED: {reason}", activate=True)
        await self.emit("message_rejected", {"from_agent_id": agent.id, "to_agent_id": to_id, "to": a.to, "type": a.type,
                                             "reason": reason, "content": a.content[:300]})

    async def act_send_message(self, agent: AgentSpec, a: A.SendMessage) -> None:
        to = a.to.strip()
        if to.lower() in ("all", "everyone", "broadcast", "team", "@all"):
            targets = list(allowed_recipients(self.edges, agent.id))
            if not targets:
                await self.reject(agent, None, a, "You have no outgoing channels.")
            for tid in targets:
                await self._send_one(agent, tid, a)
            return
        if to.lower() in ("user", "human", "the user"):
            await self.reject(agent, None, a, "To contact the user use request_user_input (if enabled) or report to your manager.")
            return
        tid = self.resolve_agent(to)
        if tid is None:
            await self.reject(agent, None, a, f"Unknown recipient '{to}'. Allowed: {', '.join(self.names[r] for r in allowed_recipients(self.edges, agent.id)) or 'none'}")
            return
        await self._send_one(agent, tid, a)

    async def _send_one(self, agent: AgentSpec, tid: str, a: A.SendMessage) -> None:
        edge = find_channel(self.edges, agent.id, tid, a.type)
        if edge is None:
            await self.reject(agent, tid, a, rejection_reason(self.edges, agent.id, tid, a.type, self.names))
            return
        cfg = edge.config or {}
        max_turns = int(cfg.get("max_turns", 20))
        if self.edge_counts[edge.id] >= max_turns:
            await self.reject(agent, tid, a, f"Channel turn limit reached (max_turns={max_turns}). Wrap up or escalate via another channel.")
            return
        if self.loop.check(agent.id, tid, a.type, a.content):
            await self.reject(agent, tid, a, "Loop detected: this is near-identical to a recent message. Summarize progress and move forward, escalate, or finish.")
            await self.emit("error", {"message": f"Loop detector: {agent.name} → {self.names[tid]} repeated a message", "agent_id": agent.id, "kind": "loop"})
            return
        content, meta = a.content, {}
        notices: dict[str, str] = {}
        protocol_event: dict[str, Any] | None = None
        activating = False
        if edge.type == "debate" and a.type in DEBATE_PROTOCOL_TYPES:
            st = self.debates.get(edge.id) or DebateState(edge.id, [edge.source, edge.target], max_rounds=int(cfg.get("max_rounds", 4)))
            v = debate_on_message(st, agent.id, a.type, content)
            if not v.accept:
                await self.reject(agent, tid, a, v.reason)
                return
            self.debates[edge.id] = st
            notices, protocol_event = v.notices, v.event
            activating = bool(v.event and v.event.get("result") == "max_rounds")
            meta["debate"] = {"round": st.rounds, "max_rounds": st.max_rounds, "status": st.status, "number": st.number}
            if st.status == "consensus" and protocol_event:
                self.decisions.append(f"Consensus ({self.names[edge.source]} ↔ {self.names[edge.target]}): {st.outcome[:240]}")
        elif a.type in ("review_request", "review_result"):
            if edge.type == "review":
                author, reviewer = (agent.id, tid) if a.type == "review_request" else (tid, agent.id)
                key = f"{edge.id}:{author}"
                rst = self.reviews.get(key) or ReviewState(edge.id, author, reviewer, max_revisions=int(cfg.get("max_revisions", 3)))
                if a.type == "review_request":
                    v = review_on_request(rst)
                else:
                    verdict = a.verdict or infer_verdict(content)
                    v = review_on_result(rst, verdict, a.comments)
                    meta.update(verdict=verdict, comments=a.comments)
                if not v.accept:
                    await self.reject(agent, tid, a, v.reason)
                    return
                self.reviews[key] = rst
                notices, protocol_event = v.notices, v.event
                activating = bool(v.event and v.event.get("result") == "max_revisions")
                meta["review"] = {"revisions": rst.revisions, "max_revisions": rst.max_revisions, "status": rst.status}
            elif a.type == "review_result":
                meta.update(verdict=a.verdict or infer_verdict(content), comments=a.comments)
            if a.comments:
                content += "\n\n" + "\n".join(f"{i}. {c}" for i, c in enumerate(a.comments, 1))
        if cfg.get("condition") and not await self.condition_met(agent, edge, a):
            await self.reject(agent, tid, a, f"Channel condition not met: \"{cfg['condition']}\".")
            return
        if a.type == "task":
            meta["task_id"] = await self.link_task(agent.id, tid, a.task_id, content)
        elif a.task_id:
            meta["task_id"] = a.task_id
        self.edge_counts[edge.id] += 1
        await self.post_message(sender="agent", from_id=agent.id, to_id=tid, type_=a.type, content=content, edge_id=edge.id, meta=meta)
        await self.emit("edge_activity", {"edge_id": edge.id, "from_agent_id": agent.id, "to_agent_id": tid, "type": a.type,
                                          "count": self.edge_counts[edge.id], "max_turns": max_turns})
        if a.type == "decision":
            for d in self.debates.values():
                if tid in d.participants and debate_decided_externally(d, content):
                    await self.emit("protocol", {"kind": "debate", "result": "decided", "edge_id": d.edge_id, "state": d.to_dict()})
            self.decisions.append(f"Decision by {agent.name}: {content.splitlines()[0][:240]}")
        if protocol_event:
            state = self.debates[edge.id].to_dict() if protocol_event["kind"] == "debate" else self.reviews[f"{edge.id}:{agent.id if a.type == 'review_request' else tid}"].to_dict()
            await self.emit("protocol", {**protocol_event, "edge_id": edge.id, "state": state})
        for pid, text in notices.items():
            self.notice(pid, text, activate=activating)

    async def condition_met(self, agent: AgentSpec, edge: EdgeSpec, a: A.SendMessage) -> bool:
        """Evaluate a natural-language edge condition with a tiny LLM judge call (mock: always satisfied)."""
        cond = edge.config.get("condition", "")
        req = LLMRequest(provider=agent.provider, model=agent.model, temperature=0, max_tokens=5, messages=[
            {"role": "system", "content": "You are a strict gatekeeper. Answer only YES or NO."},
            {"role": "user", "content": f"Channel condition: {cond}\nBlackboard:\n{self.blackboard()[:3000]}\n\n"
                                        f"Message ({a.type}): {a.content[:2000]}\n\nIs the condition satisfied?"}],
            metadata={"kind": "chat", "mock_script": "YES"})
        try:
            if self.budget.force_mock:
                req.provider, req.model = "mock", "mock/demo"
            async with registry_factory()() as rdb:
                req, _ = await prepare_request(rdb, self.user_id, req)
            out = ""
            async for ch in stream_with_retry(req, retries=1):
                out += ch.delta
                if ch.usage:
                    self.tokens += ch.usage.total_tokens
                    self.cost += ch.usage.cost_usd
            return not out.strip().upper().startswith("NO")
        except LLMError:
            return True  # fail open: do not block the run on a judge failure

    async def link_task(self, creator: str, assignee: str, task_key: str | None, content: str) -> str:
        if task_key and task_key in self.tasks:
            t = self.tasks[task_key]
            if not t["assignee"]:
                t["assignee"] = assignee
                await self.save_task(t)
            return task_key
        for t in self.tasks.values():
            if t["assignee"] == assignee and t["status"] == "todo":
                return t["key"]
        title = next((ln.strip("#*- ") for ln in content.splitlines() if ln.strip()), "Task")[:100]
        t = await self.create_task(creator, {"title": title, "description": content[:1500], "assignee": assignee, "status": "todo",
                                             "acceptance_criteria": ""})
        return t["key"]

    async def create_task(self, creator: str | None, fields: dict[str, Any]) -> dict[str, Any]:
        self.task_counter += 1
        t = {"id": new_id(), "key": f"T-{self.task_counter}", "title": fields.get("title") or "Untitled task",
             "description": fields.get("description") or "", "assignee": fields.get("assignee"), "status": fields.get("status") or "todo",
             "acceptance_criteria": fields.get("acceptance_criteria") or "", "created_by": creator}
        self.tasks[t["key"]] = t
        await self.save_task(t, new=True)
        return t

    async def save_task(self, t: dict[str, Any], new: bool = False) -> None:
        async with self.db() as db:
            if new:
                db.add(Task(id=t["id"], run_id=self.run_id, key=t["key"], title=t["title"], description=t["description"],
                            assignee_agent_id=t["assignee"], status=t["status"], acceptance_criteria=t["acceptance_criteria"],
                            created_by=t["created_by"]))
            else:
                await db.execute(update(Task).where(Task.id == t["id"]).values(
                    title=t["title"], description=t["description"], assignee_agent_id=t["assignee"], status=t["status"],
                    acceptance_criteria=t["acceptance_criteria"], updated_at=utcnow()))
            await db.commit()
        await self.emit("task_updated", {"task": {**t, "assignee_agent_id": t["assignee"], "run_id": self.run_id}})

    async def act_update_task_board(self, agent: AgentSpec, a: A.UpdateTaskBoard) -> None:
        cid = await self._tool_event(agent, "update_task_board", {"count": len(a.tasks)})
        changed = []
        for item in a.tasks:
            ac = "\n".join(f"- {x}" for x in item.acceptance_criteria) if isinstance(item.acceptance_criteria, list) else item.acceptance_criteria
            assignee = None
            if item.assignee:
                assignee = self.resolve_agent(item.assignee)
                if assignee is None:
                    self.notice(agent.id, f"Task assignee '{item.assignee}' is not on the team; left unassigned.")
            key = (item.key or "").upper()
            if key and key in self.tasks:
                t = self.tasks[key]
                for f, v in (("title", item.title), ("description", item.description), ("status", item.status), ("acceptance_criteria", ac)):
                    if v is not None:
                        t[f] = v
                if assignee:
                    t["assignee"] = assignee
                await self.save_task(t)
                changed.append(f"{key} → {t['status']}")
            elif item.title:
                t = await self.create_task(agent.id, {"title": item.title, "description": item.description, "assignee": assignee,
                                                      "status": item.status, "acceptance_criteria": ac})
                changed.append(f"created {t['key']}")
            else:
                self.notice(agent.id, f"Unknown task key '{item.key}'. Existing: {', '.join(self.tasks) or 'none'}")
        await self._tool_result(agent, cid, "update_task_board", True, ", ".join(changed))

    async def act_write_file(self, agent: AgentSpec, a: A.WriteFile) -> None:
        cid = await self._tool_event(agent, "write_file", {"path": a.path, "bytes": len(a.content), "note": a.note})
        fs = self.fs_for(agent.id)
        try:
            rel, _ = fs.resolve(a.path)
            old = fs.current(rel)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "write_file", f"write_file failed: {exc}")
            return
        if old == a.content:
            self.notice(agent.id, f"{rel} unchanged (identical content).")
            await self._tool_result(agent, cid, "write_file", True, "unchanged")
            return
        planned = fs.shadow is not None
        ok, reason = await self.guard(agent, "write_file", f"{agent.name} wants to {'create' if old is None else 'modify'} {rel}",
                                      a.content, {"path": rel, "old": (old or "")[:20000], "new": a.content[:20000], "note": a.note})
        if not ok:
            await self.deny(agent, cid, "write_file", reason)
            return
        await self.set_agent_status(agent.id, "writing", f"Saving {rel}…")
        try:
            fs.write(rel, a.content)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "write_file", f"write_file failed: {exc}")
            return
        prev = self.artifacts.get(rel)
        version = (prev or {}).get("version", 0) + 1
        art = Artifact(id=new_id(), run_id=self.run_id, path=rel, content=a.content, version=version, author_agent_id=agent.id,
                       change_note=a.note[:1000], planned=planned, created_at=utcnow(),
                       previous_content=(fs.original(rel) if planned else old) if prev is None else None)
        async with self.db() as db:
            db.add(art)
            await db.commit()
        added = a.content.count("\n") + 1
        removed = (old or "").count("\n") + 1 if old else 0
        self.artifacts[rel] = {"version": version, "author": agent.id, "note": a.note}
        await self.emit("artifact_updated", {"artifact": {"id": art.id, "run_id": self.run_id, "path": rel, "version": version,
                                                          "author_agent_id": agent.id, "change_note": a.note, "size": len(a.content),
                                                          "planned": planned, "created": old is None,
                                                          "lines": added, "previous_lines": removed,
                                                          "created_at": art.created_at.isoformat()}})
        verb = "Planned" if planned else ("Created" if old is None else "Updated")
        await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                                content=f"{verb} `{rel}` (v{version})" + (f": {a.note}" if a.note else ""),
                                meta={"path": rel, "version": version, "artifact_id": art.id, "planned": planned}, deliver=False)
        self.notice(agent.id, f"{verb} {rel} (v{version})." + (" (plan mode: saved as a proposal, the project is unchanged)" if planned else ""))
        await self._tool_result(agent, cid, "write_file", True, f"{rel} v{version}{' (planned)' if planned else ''}")

    async def act_read_file(self, agent: AgentSpec, a: A.ReadFile) -> None:
        cid = await self._tool_event(agent, "read_file", {"path": a.path})
        await self.set_agent_status(agent.id, "reading", f"Reading {a.path}…")
        try:
            content = self.fs_for(agent.id).read(a.path)
            ok = True
        except WorkspaceError as exc:
            content, ok = str(exc), False
        self.observe(agent.id, {"tool": "read_file", "ok": ok, "content": f"{a.path}:\n{content}"})
        await self._tool_result(agent, cid, "read_file", ok, content[:1000])

    async def act_list_files(self, agent: AgentSpec, a: A.ListFiles) -> None:
        cid = await self._tool_event(agent, "list_files", {"prefix": a.prefix})
        await self.set_agent_status(agent.id, "reading", f"Listing {a.prefix or 'project'} files…")
        try:
            files = self.fs_for(agent.id).list(a.prefix.strip().strip("/"))
            out, ok = ("\n".join(files[:400]) + (f"\n… {len(files) - 400} more" if len(files) > 400 else "")) or "(no files)", True
        except WorkspaceError as exc:
            out, ok = str(exc), False
        self.observe(agent.id, {"tool": "list_files", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "list_files", ok, out[:2000])

    async def load_mcp(self) -> None:
        """Resolve MCP servers granted to each agent (only the run owner's registered, enabled servers)."""
        from app.models import McpServer
        from app.tools.mcp_client import McpConfig

        wanted = {sid for a in self.agents.values() for sid in (a.tools.get("mcp_servers") or [])}
        if not wanted:
            return
        async with registry_factory()() as rdb:
            rows = (await rdb.execute(select(McpServer).where(McpServer.id.in_(wanted), McpServer.user_id == self.user_id,
                                                              McpServer.enabled.is_(True)))).scalars().all()
        self.mcp_configs = {r.id: McpConfig.from_row(r) for r in rows}
        for a in self.agents.values():
            a.mcp = [{"id": c.id, "name": c.name, "tools": c.tools} for sid in (a.tools.get("mcp_servers") or [])
                     if (c := self.mcp_configs.get(sid))]

    async def act_mcp_call(self, agent: AgentSpec, a: A.McpCall) -> None:
        from app.tools.mcp_client import call_tool

        cid = await self._tool_event(agent, f"mcp:{a.server}/{a.tool}", {"server": a.server, "tool": a.tool, "arguments": a.arguments})
        granted = {m["name"].lower(): m["id"] for m in agent.mcp}
        sid = granted.get(a.server.lower())
        cfg = self.mcp_configs.get(sid) if sid else None
        if cfg is None:
            await self.deny(agent, cid, "mcp_call", f"MCP server '{a.server}' is not granted to you. Granted: {', '.join(m['name'] for m in agent.mcp) or 'none'}")
            return
        if cfg.tools and a.tool not in {t["name"] for t in cfg.tools}:
            await self.deny(agent, cid, "mcp_call", f"Unknown tool '{a.tool}' on MCP server '{cfg.name}'.")
            return
        ok, reason = await self.guard(agent, "mcp_call", f"{agent.name} wants to call {cfg.name}/{a.tool}",
                                      str(a.arguments), {"server": cfg.name, "tool": a.tool, "arguments": a.arguments})
        if not ok:
            await self.deny(agent, cid, "mcp_call", reason)
            return
        await self.set_agent_status(agent.id, "tool", f"Calling {cfg.name}/{a.tool}…")
        ok, out = await call_tool(cfg, a.tool, a.arguments)
        self.observe(agent.id, {"tool": f"mcp:{cfg.name}/{a.tool}", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "mcp_call", ok, out)

    async def act_run_code(self, agent: AgentSpec, a: A.RunCode) -> None:
        cid = await self._tool_event(agent, "run_code", {"command": a.command})
        level = self.levels.get(agent.id, self.level)
        try:
            parse_command(a.command, danger=level == "danger")
        except SandboxError as exc:
            await self.deny(agent, cid, "run_code", f"Command rejected by sandbox: {exc}")
            return
        ok, reason = await self.guard(agent, "run_code", f"{agent.name} wants to run `{a.command[:80]}`", a.command,
                                      {"command": a.command, "cwd": "."})
        if not ok:
            await self.deny(agent, cid, "run_code", reason)
            return
        await self.set_agent_status(agent.id, "running", f"$ {a.command[:70]}")
        try:
            res = await run_command(a.command, self.root, danger=level == "danger")
            ok = res.ok
            out = f"$ {a.command}\n(exit {res.exit_code}{', timed out' if res.timed_out else ''}, {res.backend})\n{res.output}"
        except SandboxError as exc:
            ok, out = False, f"Command rejected by sandbox: {exc}"
        self.observe(agent.id, {"tool": "run_code", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "run_code", ok, out)

    async def act_calculate(self, agent: AgentSpec, a: A.Calculate) -> None:
        cid = await self._tool_event(agent, "calculate", {"expression": a.expression})
        try:
            out, ok = basic.calculate(a.expression), True
        except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, TypeError) as exc:
            out, ok = f"error: {exc}", False
        self.observe(agent.id, {"tool": "calculate", "ok": ok, "content": f"{a.expression} = {out}"})
        await self._tool_result(agent, cid, "calculate", ok, out)

    async def act_web_search(self, agent: AgentSpec, a: A.WebSearch) -> None:
        cid = await self._tool_event(agent, "web_search", {"query": a.query})
        out = await basic.web_search(a.query)
        self.observe(agent.id, {"tool": "web_search", "ok": True, "content": out})
        await self._tool_result(agent, cid, "web_search", True, out)

    async def act_remember(self, agent: AgentSpec, a: A.Remember) -> None:
        cid = await self._tool_event(agent, "remember", {"key": a.key})
        agent.memory[a.key] = a.value
        try:
            async with self.db() as db:
                row = (await db.execute(select(AgentMemory).where(AgentMemory.agent_id == agent.id, AgentMemory.key == a.key))).scalar_one_or_none()
                if row:
                    row.value = a.value
                else:
                    db.add(AgentMemory(agent_id=agent.id, key=a.key, value=a.value))
                await db.commit()
            ok = True
        except Exception:  # agent may have been deleted from the company since the run started
            ok = False
        await self._tool_result(agent, cid, "remember", ok, a.key)

    async def act_request_user_input(self, agent: AgentSpec, a: A.RequestUserInput) -> None:
        rec = await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="question", content=a.question,
                                      meta={"awaiting_input": True}, deliver=False)
        self.awaiting = {"agent_id": agent.id, "question": a.question, "message_id": rec["id"]}
        await self.set_agent_status(agent.id, "waiting")

    async def act_finish(self, agent: AgentSpec, a: A.Finish) -> None:
        if self.mode == "supervised":
            ok, reason = await self.request_approval(agent, "finish", f"{agent.name} wants to finish", a.summary, {"summary": a.summary})
            if not ok:
                self.notice(agent.id, f"The user did not accept finishing yet: {reason or 'keep going'}", activate=True)
                return
        if agent.is_entry:
            self.finished_summary = a.summary or f"{agent.name} finished."
            await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="final_report",
                                    content=self.finished_summary, deliver=False)
        else:
            self.done_agents.add(agent.id)
            await self.emit("agent_finished", {"agent_id": agent.id, "summary": a.summary})

    async def act_wait(self, agent: AgentSpec, a: A.Wait) -> None:
        return None

    # ------------------------------------------------------------------ finalisation
    async def finalize(self, status: str, reason: str) -> None:
        if self.finalized:
            return
        self.finalized = True
        for aid in self.agents:
            final = "done" if (aid in self.done_agents or (status == "completed" and self.agent_turns[aid])) else "idle"
            await self.set_agent_status(aid, final)
        summary = self.finished_summary or reason
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(
                status=status, halt_reason=reason[:200], summary=summary, ended_at=utcnow(),
                tokens_used=self.tokens, cost_usd=round(self.cost, 6), turns=self.turn_no, state_json=self.state_dict()))
            await db.commit()
        from app.services.report import build_report  # local import avoids a cycle

        try:
            report = await build_report(self.run_id, self.sf)
            async with self.db() as db:
                await db.execute(update(Run).where(Run.id == self.run_id).values(report_md=report))
                await db.commit()
        except Exception:  # pragma: no cover
            log.exception("report_failed", run_id=self.run_id)
        self.run_status = status
        await self.usage_event()
        await self.emit("run_status", {"status": status, "reason": reason, "summary": summary, "final": True})
        manager.forget(self.run_id)


class RunManager:
    """Owns live runtimes. Runs are keyed by id (UUIDs are globally unique across projects)."""

    def __init__(self) -> None:
        self.runtimes: dict[str, RunRuntime] = {}

    @staticmethod
    async def _load(run_id: str, project: ProjectRef) -> tuple[Run, str] | None:
        from app.models import Company

        async with project.sf() as db:
            run = await db.get(Run, run_id)
            if run is None:
                return None
            company = await db.get(Company, run.company_id)
            return run, company.user_id if company else ""

    async def start(self, run_id: str, project: ProjectRef) -> RunRuntime:
        loaded = await self._load(run_id, project)
        assert loaded, "run not found"
        run, user_id = loaded
        rt = RunRuntime(run, user_id, project)
        await rt._load_memory()
        await rt.load_mcp()
        self.runtimes[run_id] = rt
        rt.task = asyncio.create_task(rt.main(fresh=True), name=f"run-{run_id}")
        return rt

    async def ensure(self, run_id: str, project: ProjectRef) -> RunRuntime | None:
        """Return the live runtime, restoring a persisted (paused / interrupted) run if needed."""
        if run_id in self.runtimes:
            return self.runtimes[run_id]
        loaded = await self._load(run_id, project)
        if not loaded:
            return None
        run, user_id = loaded
        if run.status not in ACTIVE_STATES:
            return None
        rt = RunRuntime(run, user_id, project)
        await rt.restore(run)
        await rt.load_mcp()
        rt.paused = True
        self.runtimes[run_id] = rt
        rt.task = asyncio.create_task(rt.main(fresh=False), name=f"run-{run_id}")
        return rt

    def get(self, run_id: str) -> RunRuntime | None:
        return self.runtimes.get(run_id)

    def forget(self, run_id: str) -> None:
        self.runtimes.pop(run_id, None)

    def active_for(self, root: Path) -> list[RunRuntime]:
        return [rt for rt in self.runtimes.values() if rt.root == root.resolve() or rt.root == root]

    async def shutdown(self) -> None:
        tasks = [rt.task for rt in self.runtimes.values() if rt.task and not rt.task.done()]
        for rt in list(self.runtimes.values()):
            rt.stop_requested = True
            if rt.task and not rt.task.done():
                rt.task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=5)


manager = RunManager()


def default_budget() -> dict[str, Any]:
    s = get_settings()
    return RunBudget(max_turns=s.default_max_turns, max_tokens=s.default_max_tokens_budget, max_cost_usd=s.default_max_cost_usd,
                     timeout_s=s.default_timeout_s).model_dump()
