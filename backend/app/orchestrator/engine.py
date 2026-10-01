"""The Octopus orchestration runtime.

One ``RunRuntime`` per run executes as an asyncio task:

    pick next runnable agent (FIFO over mailbox + activating observations)
      → build prompt (system prompt + meta rules + roster + channels + blackboard + summary + inbox)
      → stream LLM call (token_stream events)
      → parse structured actions → execute (permissions, protocols, limits enforced here)
      → route messages to mailboxes → persist + publish events → repeat

Bounded by: global max turns, per-edge max turns, token + cost budget, active-time budget (time spent working, not paused or
waiting for the user), per-agent max autonomous turns, a lifetime ceiling across follow-ups, the loop detector and the stall
watchdog (both auto-pause for a human), human pause and kill switch.
"""
from __future__ import annotations

import asyncio
import contextvars
import json
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
from app.llm.base import CODE_AGENT_MAX_TOKENS, MAX_AGENT_MAX_TOKENS, LLMError, LLMOutputTruncated, LLMRequest, LLMResult, ToolCall
from app.llm.demo_script import role_category
from app.llm.router import get_provider, prepare_request, stream_with_retry
from app.models import AgentMemory, Artifact, Message, Run, Task
from app.orchestrator import actions as A
from app.orchestrator import tools as T
from app.orchestrator.bus import bus
from app.orchestrator.context import TOOL_RESULT_CHARS, AgentSpec, build_system_prompt, build_user_prompt, clip, team_status
from app.orchestrator.permissions import (
    EdgeSpec, allowed_recipients, effective_level, find_channel, rejection_reason,
)
from app.orchestrator.team import TeamMixin
from app.orchestrator.protocols import (
    DebateState, LoopDetector, ReviewState, debate_decided_externally, debate_on_message, infer_verdict,
    review_on_request, review_on_result,
)
from app.schemas import RunBudget
from app.services import project_memory as PM
from app.tools import basic
from app.tools.sandbox import SandboxError, parse_command, run_command
from app.tools.workspace import ProjectFS, WorkspaceError

log = get_logger("orchestrator")

DEBATE_PROTOCOL_TYPES = {"proposal", "critique", "objection", "agreement", "decision"}
ACTIVE_STATES = {"queued", "running", "paused", "awaiting_user"}
TERMINAL_STATES = {"completed", "incomplete", "failed", "cancelled"}
OPEN_TASK_STATES = {"todo", "in_progress", "in_review", "blocked"}
# How many turns in a row an agent may take only because of its own tool results / notices (no new message). Reading a
# file and acting on it needs one; an agent that keeps re-reading without producing anything is spinning.
MAX_SELF_TURNS = 3
# A run and all of its follow-ups may spend at most this multiple of the run's original budget (turns, tokens, cost, time).
FOLLOWUP_BUDGET_CEILING = 3
# Delegation as a tool call: the delegated teammate's sub-turn runs inside the delegator's tool call. These context vars
# follow each asyncio task, so parallel delegations each see their own frame.
DELEGATION: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar("octopus_delegation", default=None)
IN_TOOL_LOOP: contextvars.ContextVar[bool] = contextvars.ContextVar("octopus_in_tool_loop", default=False)
MAX_DELEGATION_DEPTH = 3  # delegator → worker → worker's report → … (cycles are refused)
JOURNAL_MAX = 400
MAX_REDELIVERIES = 2  # a message whose turn failed is shown again at most this many times
DIGEST_LINES = 40
READ_PAGE_CHARS = TOOL_RESULT_CHARS - 500  # one read_file page fits in a tool result with room for its header
# A model call is only treated as hung after this long with *no* output (reasoning summaries, text or tool arguments).
# There is no fixed cap on a call that keeps streaming: xhigh reasoning with a 128k output budget can take many minutes.
LLM_IDLE_TIMEOUT_S = 300.0
JUDGE_MAX_TOKENS = 16  # "YES"/"NO" plus slack; 5 often produced no answer at all (reasoning headroom is added on top)


def judge_verdict(text: str) -> bool | None:
    """YES → True, NO → False, anything else (empty, rambling) → None = unknown."""
    t = re.sub(r"[^A-Z]", " ", text.upper()).split()
    if not t:
        return None
    return True if t[0] == "YES" else False if t[0] == "NO" else None


def apply_edits(text: str, edits: list[A.Edit]) -> tuple[str, int]:
    """Apply exact-text edits in order. Returns (new text, 1-based line of the first change). Raises ValueError (nothing
    applied) when an old_string is missing or ambiguous, with enough detail for the model to fix its call."""
    first: int | None = None
    for i, e in enumerate(edits, 1):
        n = text.count(e.old_string)
        label = f"edit {i}" if len(edits) > 1 else "old_string"
        if n == 0 and not e.replace_all and (loose := loose_match(text, e.old_string, e.new_string)):
            start, end, new = loose  # same lines, different indentation / trailing whitespace: apply, re-indented
            line = text.count("\n", 0, start) + 1
            first = line if first is None else min(first, line)
            text = text[:start] + new + text[end:]
            continue
        if n == 0:
            stripped = e.old_string.strip()
            hint = (" (it does appear with different surrounding whitespace or indentation)" if stripped and stripped in text
                    else " (read_file to get the exact current text)")
            near = closest_region(text, e.old_string)
            raise ValueError(f"{label}: old_string not found{hint}"
                             + (f". The current text where it probably belongs (line numbers are not part of "
                                f"the file):\n{near}" if near else ""))
        if n > 1 and not e.replace_all:
            raise ValueError(f"{label}: old_string occurs {n} times; include more surrounding lines to make it unique, "
                             "or set replace_all")
        pos = text.index(e.old_string)
        line = text.count("\n", 0, pos) + 1
        first = line if first is None else min(first, line)
        text = text.replace(e.old_string, e.new_string) if e.replace_all else text.replace(e.old_string, e.new_string, 1)
    return text, first or 1


def loose_match(text: str, old: str, new: str) -> tuple[int, int, str] | None:
    """Find ``old`` in ``text`` when it differs only by a uniform indentation shift and trailing whitespace (the most
    common reason an edit from memory misses). Returns (start, end, new re-indented by the same shift), only when that
    match is unique; otherwise None. Edits that differ in anything else still fail with a hint."""
    o_lines = old.strip("\n").split("\n")
    if not old.strip() or len(o_lines) > 400:
        return None
    lines = text.split("\n")
    offsets = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln) + 1)
    nonblank = [ln for ln in o_lines if ln.strip()]
    o_ind = min(len(ln) - len(ln.lstrip()) for ln in nonblank)
    o_core = [ln[o_ind:].rstrip() if ln.strip() else "" for ln in o_lines]
    hits: list[tuple[int, str]] = []
    for i in range(len(lines) - len(o_lines) + 1):
        win = lines[i:i + len(o_lines)]
        nb = [ln for ln in win if ln.strip()]
        if len(nb) != len(nonblank):
            continue
        ind = min(len(ln) - len(ln.lstrip()) for ln in nb)
        prefix = nb[0][:ind]
        if any(ln.strip() and not ln.startswith(prefix) for ln in win):
            continue
        if [ln[ind:].rstrip() if ln.strip() else "" for ln in win] == o_core:
            hits.append((i, prefix))
            if len(hits) > 1:
                return None
    if len(hits) != 1:
        return None
    i, prefix = hits[0]
    n_lines = new.strip("\n").split("\n") if new.strip() else []

    def reindent(ln: str) -> str:  # keep each new line's indentation relative to the old text, on the file's base indent
        lead = len(ln) - len(ln.lstrip())
        if lead >= o_ind:
            return prefix + ln[o_ind:]
        return prefix[:max(0, len(prefix) - (o_ind - lead))] + ln.lstrip()

    new_text = "\n".join(reindent(ln) if ln.strip() else "" for ln in n_lines)
    start, end = offsets[i], offsets[i + len(o_lines)] - 1
    return start, end, new_text


def closest_region(text: str, old: str, span: int = 8) -> str:
    """Where a missed edit most likely applies: the current lines around the first distinctive line of ``old_string``.

    A missed old_string usually comes from editing from memory (an earlier read was shortened in a long tool loop, or a
    teammate changed the file). Showing the real text there lets the model retry at once instead of re-reading a big file."""
    lines = text.split("\n")
    wanted = sorted({ln.strip() for ln in old.split("\n") if len(ln.strip()) >= 12}, key=len, reverse=True)
    for w in wanted[:6]:
        hits = [i for i, ln in enumerate(lines) if w in ln]
        if len(hits) == 1:
            return numbered_excerpt(text, hits[0] + 1, before=3, after=span + old.count("\n"))[:4000]
    return ""


def numbered_excerpt(text: str, line: int, before: int = 3, after: int = 12) -> str:
    lines = text.split("\n")
    lo, hi = max(1, line - before), min(len(lines), line + after)
    return "\n".join(f"{n:>5}  {lines[n - 1]}" for n in range(lo, hi + 1))


def head_tail(text: str, limit: int) -> str:
    """Keep both ends of a long text: a malformed reply usually breaks at the end."""
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n…[{len(text) - limit:,} characters omitted]…\n" + text[-half:]


ROUND_WARNINGS = {5, 1}  # tool rounds left in a turn at which the agent is told to wrap up
KEEP_FULL_ROUNDS = 3  # the latest tool rounds are replayed verbatim; older ones are shortened
OLD_ROUND_CHARS = 1500
COMPACT_MARK = "; re-read the file or re-run the tool if you need it again]"


def _shorten(text: str, limit: int, what: str) -> str:
    if len(text) <= limit or text.endswith(COMPACT_MARK):
        return text
    return f"{text[:limit]}\n…[{what} shortened: {len(text):,} chars, shown in full in an earlier round{COMPACT_MARK}"



def compact_rounds(items: list[dict[str, Any]], rounds: list[int]) -> list[dict[str, Any]]:
    """Keep a long tool loop from re-sending everything every round.

    Each round replays the whole turn so far (up to max_tool_rounds rounds; one read_file result can be 60k characters,
    one write_file call carries the whole file). Rounds older than the last KEEP_FULL_ROUNDS keep their structure,
    reasoning items and call ids, but long tool outputs and long string arguments are shortened. Shortening is idempotent."""
    if len(rounds) <= KEEP_FULL_ROUNDS:
        return items
    cut = rounds[-KEEP_FULL_ROUNDS]
    out = []
    for i, item in enumerate(items):
        if i >= cut:
            out.append(item)
        elif item.get("type") == "function_call_output" and isinstance(item.get("output"), str):
            out.append({**item, "output": _shorten(item["output"], OLD_ROUND_CHARS, "tool output")})
        elif item.get("type") == "function_call" and len(item.get("arguments") or "") > OLD_ROUND_CHARS:
            try:
                args = json.loads(item["arguments"])
            except (TypeError, ValueError):
                out.append(item)
                continue
            if isinstance(args, dict):
                args = {k: _shorten(v, OLD_ROUND_CHARS, k) if isinstance(v, str) else v for k, v in args.items()}
                item = {**item, "arguments": json.dumps(args, ensure_ascii=False)}
            out.append(item)
        else:
            out.append(item)
    return out


class StopRun(Exception):
    pass


@dataclass
class ProjectRef:
    """Where a run lives: the project directory and its .octopus database."""

    workspace_id: str
    root: Path
    sf: SessionFactory


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
    if act in ("write_file", "edit_file"):
        return ("writing", f"{'Editing' if act == 'edit_file' else 'Writing'} {get('path') or 'a file'}…")
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


class RunRuntime(TeamMixin):
    def __init__(self, run: Run, user_id: str, project: ProjectRef) -> None:
        snap = run.snapshot_json or {}
        self.snapshot: dict[str, Any] = {"company": snap.get("company") or {}, "agents": list(snap.get("agents") or []),
                                         "edges": list(snap.get("edges") or []), "departments": dict(snap.get("departments") or {})}
        self.snapshot_dirty = False
        self.company_id = run.company_id
        self.project = project
        self.sf = project.sf
        self.level = run.permission_level or "ask"
        self.run_id = run.id
        self.session_id = run.session_id
        self.user_id = user_id
        self.goal = run.goal
        self.mode = run.mode
        self.budget = RunBudget(**(run.budget_json or {}))
        self.budget_base: dict[str, Any] | None = (run.state_json or {}).get("budget_base") or dict(run.budget_json or {})
        self.company_name = (snap.get("company") or {}).get("name", "Company")
        self.agents: dict[str, AgentSpec] = {}
        for a in snap.get("agents", []):
            cat = role_category(a.get("role", ""), (a.get("behavior") or {}).get("template_key", ""))
            self.agents[a["id"]] = AgentSpec.from_dict(a, cat)
        self.edges = [EdgeSpec.from_dict(e) for e in snap.get("edges", [])]
        self.names = {a.id: a.name for a in self.agents.values()}
        self.attachments: list[dict[str, Any]] = (run.state_json or {}).get("attachments", [])
        self._goal_images: list[dict[str, str]] | None = None  # loaded on first use (base64, shown to every agent)

        self.history: list[dict[str, Any]] = []
        self.mailbox: dict[str, list[tuple[int, str]]] = {}
        self.observations: dict[str, list[tuple[int, dict[str, Any]]]] = {}
        self.status: dict[str, str] = {aid: "idle" for aid in self.agents}
        self.done_agents: set[str] = set()
        self.agent_turns: Counter[str] = Counter()
        self.agent_tokens: Counter[str] = Counter()
        self.agent_cost: Counter[str] = Counter()
        # exact provider usage: input (incl. cached/cache-write), cached, cache_write, output (incl. reasoning), reasoning
        self.usage_totals: Counter[str] = Counter()
        self.cost_totals: Counter[str] = Counter()  # USD by component: input / cached_input / cache_write / output
        self.llm_calls = 0
        self.edge_counts: Counter[str] = Counter()
        self.debates: dict[str, DebateState] = {}
        self.reviews: dict[str, ReviewState] = {}
        self.loop = LoopDetector(threshold=self.budget.loop_threshold, max_strikes=self.budget.max_loop_strikes)
        self.loop_escalated = False
        self.stall_escalated = False
        self.stall_ack = run.turns or 0  # turn at which a human last resumed a stalled run
        self.tasks: dict[str, dict[str, Any]] = {}
        self.task_counter = 0
        self.artifacts: dict[str, dict[str, Any]] = {}
        self.decisions: list[str] = []
        self.user_notes: list[str] = []
        self.followups: list[str] = []  # messages sent after the run finished (the run continues like a chat)
        self.mock_state: dict[str, dict[str, Any]] = {}
        self.warned: set[str] = set()
        self.redeliveries: Counter[str] = Counter()  # message id -> times re-delivered after a failed turn
        self.browser_pages: dict[str, tuple[str, str]] = {}  # agent id -> (url, title) of its browser tab, for the Browser view
        self.rejections = 0
        # scheduling health: consecutive self-activated turns per agent, the last turn that moved the run forward,
        # and which open tasks were already nudged since then (task key -> progress_turn at nudge time)
        self.self_turns: Counter[str] = Counter()
        self.progress_turn = run.turns or 0
        self.nudged: dict[str, int] = {}
        # shared team knowledge: an engine-kept log of what happened (files, tasks, decisions, delegations, finishes) and,
        # per agent, the point up to which it has seen it, so every prompt can carry "what the team did since your last turn"
        self.journal: list[dict[str, Any]] = []
        self.journal_n = 0
        self.seen: dict[str, int] = {}
        self.seen_turn: dict[str, int] = {}
        # efficiency: turns that changed a deliverable or ran something vs. turns spent coordinating
        self.metrics: Counter[str] = Counter()
        self.first_deliverable_turn: int | None = None
        self.turn_work: dict[str, bool] = {}
        self._file_locks: dict[str, asyncio.Lock] = {}
        self._approval_lock = asyncio.Lock()
        self.memory = PM.load(project.root)  # project memory shared across runs

        self.seq = 0
        self.turn_no = run.turns or 0
        self.tokens = run.tokens_used or 0
        self.cost = run.cost_usd or 0.0
        self.active_seconds = 0.0
        self.broken_files: dict[str, str] = {}  # path → the failed automatic check of its latest version
        self.turn_t0: float | None = None  # monotonic start of the top-level turn in progress (counted live by the time limit)
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
            "agent_cost": dict(self.agent_cost), "usage_totals": dict(self.usage_totals), "cost_totals": dict(self.cost_totals),
            "llm_calls": self.llm_calls,
            "debates": {k: v.to_dict() for k, v in self.debates.items()},
            "reviews": {k: v.to_dict() for k, v in self.reviews.items()},
            "loop": self.loop.to_dict(), "task_counter": self.task_counter,
            "decisions": self.decisions, "user_notes": self.user_notes, "followups": self.followups, "mock_state": self.mock_state,
            "active_seconds": round(self.active_seconds, 2), "awaiting": self.awaiting,
            "pending_approval": self.pending_approval, "rejections": self.rejections,
            "auto_approve": sorted(self.auto_approve), "levels": self.levels, "activity": self.activity,
            "budget_base": self.budget_base,
            "self_turns": dict(self.self_turns), "progress_turn": self.progress_turn, "nudged": self.nudged,
            "stall_ack": self.stall_ack,
            "broken_files": self.broken_files,
            "journal": self.journal[-JOURNAL_MAX:], "journal_n": self.journal_n, "seen": self.seen, "seen_turn": self.seen_turn,
            "metrics": self.efficiency(),
        }

    async def save(self) -> None:
        values: dict[str, Any] = {"tokens_used": self.tokens, "cost_usd": round(self.cost, 8), "turns": self.turn_no, "state_json": self.state_dict()}
        if self.snapshot_dirty:
            values["snapshot_json"] = self.snapshot
            self.snapshot_dirty = False
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(**values))
            await db.commit()

    async def restore(self, run: Run) -> None:
        st = run.state_json or {}
        self.status.update(st.get("status", {}))
        self.done_agents = set(st.get("done_agents", []))
        self.broken_files = dict(st.get("broken_files", {}))
        self.agent_turns = Counter(st.get("agent_turns", {}))
        self.agent_tokens = Counter(st.get("agent_tokens", {}))
        self.agent_cost = Counter(st.get("agent_cost", {}))
        self.usage_totals = Counter(st.get("usage_totals", {}))
        self.cost_totals = Counter(st.get("cost_totals", {}))
        self.llm_calls = st.get("llm_calls", 0)
        self.edge_counts = Counter(st.get("edge_counts", {}))
        self.debates = {k: DebateState.from_dict(v) for k, v in st.get("debates", {}).items()}
        self.reviews = {k: ReviewState.from_dict(v) for k, v in st.get("reviews", {}).items()}
        if st.get("loop"):
            self.loop = LoopDetector.from_dict(st["loop"])
        self.task_counter = st.get("task_counter", 0)
        self.decisions, self.user_notes = st.get("decisions", []), st.get("user_notes", [])
        self.followups = st.get("followups", [])
        self.mock_state = st.get("mock_state", {})
        self.active_seconds = float(st.get("active_seconds", 0))
        self.awaiting = st.get("awaiting")
        self.rejections = st.get("rejections", 0)
        self.auto_approve = set(st.get("auto_approve", []))
        self.self_turns = Counter(st.get("self_turns", {}))
        self.progress_turn = int(st.get("progress_turn", self.turn_no))
        self.nudged = dict(st.get("nudged", {}))
        self.stall_ack = int(st.get("stall_ack", self.turn_no))
        self.journal = list(st.get("journal", []))
        self.journal_n = int(st.get("journal_n", len(self.journal)))
        self.seen = dict(st.get("seen", {}))
        self.seen_turn = dict(st.get("seen_turn", {}))
        m = st.get("metrics") or {}
        self.metrics = Counter({k: int(m.get(k, 0)) for k in ("turns", "work_turns", "delegations", "parallel_delegations")})
        self.first_deliverable_turn = m.get("first_deliverable_turn")
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
            "tokens": self.tokens, "cost_usd": round(self.cost, 8), "turns": self.turn_no,
            "max_turns": self.budget.max_turns, "max_tokens": self.budget.max_tokens, "max_cost_usd": self.budget.max_cost_usd,
            "per_agent": dict(self.agent_tokens), "active_seconds": round(self.active_seconds, 1), "timeout_s": self.budget.timeout_s,
            "per_agent_cost": {k: round(v, 6) for k, v in self.agent_cost.items()},
            "input_tokens": self.usage_totals["input"], "cached_tokens": self.usage_totals["cached"],
            "cache_write_tokens": self.usage_totals["cache_write"], "output_tokens": self.usage_totals["output"],
            "reasoning_tokens": self.usage_totals["reasoning"], "llm_calls": self.llm_calls,
            "estimated_calls": self.usage_totals["estimated_calls"],
            "cost_breakdown": {k: round(v, 6) for k, v in self.cost_totals.items()},
            "progress_turn": self.progress_turn, "turns_since_progress": self.turn_no - self.progress_turn,
        })

    def add_usage(self, agent_id: str | None, u: Any) -> None:
        """Accumulate one LLM call's exact usage (as reported by Azure) and its priced cost."""
        self.tokens += u.total_tokens
        self.cost += u.cost_usd
        self.llm_calls += 1
        if getattr(u, "estimated", False):
            self.usage_totals["estimated_calls"] += 1
        self.usage_totals.update({"input": u.prompt_tokens, "cached": u.cached_tokens, "cache_write": u.cache_write_tokens,
                                  "output": u.completion_tokens, "reasoning": u.reasoning_tokens})
        self.cost_totals.update({k: v for k, v in (u.cost_breakdown or {}).items() if v})
        if agent_id:
            self.agent_tokens[agent_id] += u.total_tokens
            self.agent_cost[agent_id] += u.cost_usd

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
                           edge_id: str | None = None, meta: dict[str, Any] | None = None, deliver: bool = True,
                           announce: bool = True) -> dict[str, Any]:
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
        if announce:
            await self.announce_message(rec, m.created_at.isoformat())
        return rec

    async def announce_message(self, m: dict[str, Any], created_at: str, *, to_everyone: bool = False) -> None:
        """Show a message in the run (feed, timeline, canvas). A broadcast's per-agent copies are announced once, to everyone."""
        await self.emit("message_created", {"message": {
            "id": m["id"], "run_id": self.run_id, "session_id": self.session_id, "sender": m["sender"], "from_agent_id": m["from"],
            "to_agent_id": None if to_everyone else m["to"], "edge_id": m["edge_id"], "type": m["type"], "content": m["content"],
            "meta": m["meta"], "turn_no": m["turn"], "created_at": created_at}})

    async def requeue(self, aid: str, inbox_ids: list[str]) -> bool:
        """A turn failed before the agent could act on its messages: deliver them again, so they stay NEW instead of silently
        sliding into history (the agent then lost track of what it was asked and re-asked or looped). Bounded per message."""
        again = [mid for mid in inbox_ids if self.redeliveries[mid] < MAX_REDELIVERIES]
        if not again:
            return False
        for mid in again:
            self.redeliveries[mid] += 1
            self.deliver(aid, mid)
        async with self.db() as db:
            await db.execute(update(Message).where(Message.id.in_(again)).values(read=False))
            await db.commit()
        return True

    def next_runnable(self) -> str | None:
        """FIFO over queued messages and activating observations. An agent that has already taken MAX_SELF_TURNS turns in a
        row on its own observations (no new message, no progress) is only woken by a message again."""
        best: tuple[int, str] | None = None
        for aid in self.agents:
            if not self.agents[aid].active:
                continue
            seqs = [s for s, _ in self.mailbox.get(aid, [])]
            if self.self_turns[aid] < MAX_SELF_TURNS:
                seqs += [s for s, o in self.observations.get(aid, []) if o.get("activate")]
            if seqs:
                s = min(seqs)
                if best is None or s < best[0]:
                    best = (s, aid)
        return best[1] if best else None

    # ------------------------------------------------------------------ task board awareness
    def log(self, aid: str | None, text: str) -> None:
        """Record something the whole team should know about (shown to each agent once, in its next prompt)."""
        self.journal_n += 1
        self.journal.append({"n": self.journal_n, "turn": self.turn_no, "agent": aid, "text": text[:500]})
        del self.journal[:-JOURNAL_MAX]

    def decide(self, text: str, aid: str | None = None) -> None:
        self.decisions.append(text)
        self.log(aid, text)

    def digest(self, aid: str) -> str:
        """What teammates did since this agent's last turn: the engine's log plus one line per message between others."""
        since, since_turn = self.seen.get(aid, 0), self.seen_turn.get(aid, -1)
        rows: list[tuple[int, str]] = [(e["turn"], f"- t{e['turn']} {self.names.get(e['agent'] or '', 'Octopus')}: {e['text']}")
                                       for e in self.journal if e["n"] > since and e["agent"] != aid]
        for m in self.history:
            if m["turn"] <= since_turn or aid in (m["from"], m["to"]) or m["type"] == "artifact_created" or m["from"] is None:
                continue
            first = (m["content"].strip().splitlines() or [""])[0][:200]
            to = self.names.get(m["to"] or "", "everyone")
            rows.append((m["turn"], f"- t{m['turn']} {self.names.get(m['from'], '?')} → {to} ({m['type']}): {first}"))
        rows.sort(key=lambda r: r[0])
        lines = [r[1] for r in rows]
        if len(lines) > DIGEST_LINES:
            lines = [f"- … {len(lines) - DIGEST_LINES} earlier entries (see the Blackboard and files)"] + lines[-DIGEST_LINES:]
        return "\n".join(lines)

    def mark_work(self, aid: str) -> None:
        """This turn changed a deliverable or ran something (as opposed to only coordinating)."""
        if not self.turn_work.get(aid):
            self.turn_work[aid] = True
            self.metrics["work_turns"] += 1

    def start_turn_metrics(self, aid: str) -> None:
        self.metrics["turns"] += 1
        self.turn_work[aid] = False

    def efficiency(self) -> dict[str, Any]:
        turns = self.metrics["turns"]
        return {"turns": turns, "work_turns": self.metrics["work_turns"],
                "overhead_share": round(1 - self.metrics["work_turns"] / turns, 3) if turns else 0.0,
                "first_deliverable_turn": self.first_deliverable_turn, "delegations": self.metrics["delegations"],
                "parallel_delegations": self.metrics["parallel_delegations"]}

    def file_lock(self, rel: str) -> asyncio.Lock:
        return self._file_locks.setdefault(rel, asyncio.Lock())

    def mark_progress(self) -> None:
        """Something moved the run forward (a file changed, a task changed status, a verdict, a finish, user input)."""
        self.progress_turn = self.turn_no

    def open_tasks(self) -> list[dict[str, Any]]:
        return [t for t in self.tasks.values() if t["status"] in OPEN_TASK_STATES]

    def task_line(self, t: dict[str, Any]) -> str:
        return f"{t['key']} [{t['status']}] {t['title']} (assignee: {self.names.get(t['assignee'] or '', 'unassigned')})"

    def open_task_owners(self) -> list[str]:
        owners: list[str] = []
        for t in self.open_tasks():
            a = t["assignee"]
            if a in self.agents and self.agents[a].active and a not in owners:
                owners.append(a)
        return owners

    async def nudge_open_tasks(self) -> bool:
        """Nobody has a queued message but the board still has open tasks: wake whoever can move them.

        Owners of actionable tasks are woken; tasks that are blocked, unassigned or owned by an inactive agent go to the
        entry agent (when *every* open task is blocked the board is deadlocked and the entry agent must resolve it). Each
        task is nudged at most once until the run makes progress again, so a stuck board ends instead of spinning."""
        open_ = self.open_tasks()
        if not open_:
            return False
        deadlocked = all(t["status"] == "blocked" for t in open_)
        entry = (self.entry_agents() or [None])[0]
        targets: dict[str, list[dict[str, Any]]] = {}
        for t in open_:
            if self.nudged.get(t["key"]) == self.progress_turn:
                continue
            owner = t["assignee"]
            if deadlocked or t["status"] == "blocked" or owner not in self.agents or not self.agents[owner].active:
                owner = entry
            if owner is None:
                continue
            self.nudged[t["key"]] = self.progress_turn
            targets.setdefault(owner, []).append(t)
        for aid, ts in targets.items():
            lines = "\n".join(f"- {self.task_line(t)}" for t in ts)
            if deadlocked:
                body = (f"Every open task on the board is blocked, so nobody can move:\n{lines}\n\nResolve the blocker (do the missing "
                        "work yourself or assign it to someone who can), re-plan the tasks, or ask the user. Update the task board.")
            else:
                body = (f"These tasks are still open and nobody is working on them:\n{lines}\n\nContinue them now, or update the task "
                        "board (done / blocked with the reason) and tell whoever is waiting on you.")
            await self.post_message(sender="system", from_id=None, to_id=aid, type_="task", content="[Octopus scheduler] " + body,
                                    meta={"nudge": True, "tasks": [t["key"] for t in ts]})
        if targets:
            await self.emit("error", {"kind": "warning", "message": ("Task board deadlock: every open task is blocked; asked "
                                                                     if deadlocked else "Run went idle with open tasks; woke ")
                                      + ", ".join(self.names.get(a, a) for a in targets)})
        return bool(targets)

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
    def active_now(self) -> float:
        """Active time including the turn in progress: one long turn (a 40-round tool loop with nested delegations) used to
        run far past the time limit, because the limit only saw the time of finished turns."""
        return self.active_seconds + (time.monotonic() - self.turn_t0 if self.turn_t0 is not None else 0.0)

    def limit_reason(self, *, turns: bool = True) -> str | None:
        """``turns=False`` inside a turn's tool loop: the turn is already counted, only spend and time can run out."""
        b = self.budget
        reason = None
        if turns and self.turn_no >= b.max_turns:
            reason = f"Budget: max turns reached ({b.max_turns})"
        elif self.tokens >= b.max_tokens:
            reason = f"Budget: token budget exhausted ({self.tokens}/{b.max_tokens})"
        elif b.max_cost_usd > 0 and self.cost >= b.max_cost_usd:
            reason = f"Budget: cost budget exhausted (${self.cost:.4f}/${b.max_cost_usd:.2f})"
        elif self.active_now() >= b.timeout_s:  # time spent working; paused / waiting-for-you time is not counted
            reason = f"Budget: active-time limit reached ({b.timeout_s}s of agent work)"
        if reason and self.followups:
            reason += f"; follow-ups share a lifetime ceiling of {FOLLOWUP_BUDGET_CEILING}x the run budget, start a new run to go further"
        return reason

    async def check_stall(self) -> None:
        """Progress watchdog: no file changed and no task moved for ``stall_turns`` turns → pause and show the human the board."""
        n = self.budget.stall_turns
        if not n or self.stall_escalated or self.turn_no - max(self.progress_turn, self.stall_ack) < n:
            return
        self.stall_escalated = True
        self.paused = True
        open_ = self.open_tasks()
        board = "; ".join(f"{t['key']} {t['status']}" for t in open_[:8]) or "no open tasks"
        await self.emit("error", {"kind": "stall", "message": (
            f"No progress for {self.turn_no - self.progress_turn} turns: no file changed and no task moved since turn {self.progress_turn} "
            f"(board: {board}). Run paused; interject to steer, then resume, or stop it.")})

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
        if self.loop_escalated:  # keep the evidence; the next repeat pauses again instead of needing max_strikes more
            self.loop.acknowledge(hot=True)
        self.loop_escalated = False
        if self.stall_escalated:
            self.stall_ack = self.turn_no
        self.stall_escalated = False
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

    async def continue_with(self, content: str, to_agent_id: str | None) -> None:
        """Re-open a finished run with a follow-up. Same run, same history, files and task board; budgets get fresh headroom."""
        self.followups.append(content)  # bounded by the API (20k); shown with a visible cut on the Blackboard
        self.finalized = False
        self.finished_summary = None
        self.loop_escalated = self.stall_escalated = False
        self.loop.acknowledge(hot=False)
        self.stall_ack = self.turn_no
        self.paused = False
        self.stop_requested = False
        self.awaiting = None
        self.agent_turns = Counter()  # per-agent autonomy limits apply per request
        # Each follow-up gets fresh headroom of one base budget, but never beyond FOLLOWUP_BUDGET_CEILING x the base over
        # the run's lifetime: N follow-ups must not mean N x the spend the user agreed to.
        base = RunBudget(**(self.budget_base or self.budget.model_dump()))
        ceil = FOLLOWUP_BUDGET_CEILING
        self.budget.max_turns = min(2000, self.turn_no + base.max_turns, base.max_turns * ceil)
        self.budget.max_tokens = min(self.tokens + base.max_tokens, base.max_tokens * ceil)
        if base.max_cost_usd > 0:
            self.budget.max_cost_usd = round(min(self.cost + base.max_cost_usd, base.max_cost_usd * ceil), 6)
        self.budget.timeout_s = min(86400, int(self.active_seconds) + base.timeout_s, base.timeout_s * ceil)
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(ended_at=None, halt_reason="", budget_json=self.budget.model_dump()))
            await db.commit()
        self.self_turns = Counter()
        self.nudged = {}
        self.mark_progress()
        await self.set_run_status("running")
        await self.emit("run_continued", {"content": content, "to_agent_id": to_agent_id, "followup": len(self.followups)})
        if to_agent_id in self.agents:
            targets = [to_agent_id]
        else:  # "entry agent": the entry agent plus everyone who still owns an open task (they'd never be woken otherwise)
            targets = list(dict.fromkeys(self.entry_agents() + self.open_task_owners()))
        for t in targets:
            mine = [x for x in self.open_tasks() if x["assignee"] == t]
            owned = ("\n\nYou still own these open tasks:\n" + "\n".join(f"- {self.task_line(x)}" for x in mine)
                     + "\nContinue them, or update the task board.") if mine else ""
            await self.post_message(sender="user", from_id=None, to_id=t, type_="task", meta={"followup": True},
                                    content=f"Follow-up from the user: {content}\n\nThe previous work is in the project (see Workspace files). "
                                            f"Change what's needed and report back; don't start over.{owned}")
        self.wake.set()

    async def interject(self, content: str, to_agent_id: str | None) -> None:
        targets = [t for t in ([to_agent_id] if to_agent_id else self.agents) if t in self.agents and self.agents[t].active]
        self.user_notes.append(clip(content, 1000))
        self.mark_progress()  # new information from the user re-opens every nudge
        # A message to everyone is one message: each agent gets its own copy in its inbox, but the run shows it once
        # (it used to appear once per agent in the feed and timeline).
        group = new_id() if len(targets) > 1 else None
        first: dict[str, Any] | None = None
        for t in targets:
            meta = {"broadcast": group, "recipients": len(targets)} if group else {}
            rec = await self.post_message(sender="user", from_id=None, to_id=t, type_="user_interjection", content=content,
                                          meta=meta, announce=not group)
            first = first or rec
        if group and first:
            await self.announce_message(first, utcnow().isoformat(), to_everyone=True)
        # The user is talking to the team: that answers a pending question and resumes a paused run (a paused run used to
        # stay paused after "continue" until Resume was pressed). Pause again any time with Pause / Space.
        self.awaiting = None
        if self.paused:  # step mode still waits for Next turn
            self.resume()
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
        async with self._approval_lock:  # one approval card at a time, even when delegated teammates work in parallel
            return await self._request_approval(agent, kind, summary, preview, details)

    async def _request_approval(self, agent: AgentSpec, kind: str, summary: str, preview: str,
                                details: dict[str, Any] | None = None) -> tuple[bool, str]:
        if f"{agent.id}:{kind}" in self.auto_approve:  # an earlier card in the queue may have said "always"
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
        active = [aid for aid, a in self.agents.items() if a.active]
        entries = [aid for aid in active if self.agents[aid].is_entry]
        if entries:
            return entries
        targets = {e.target for e in self.edges} | {e.source for e in self.edges if e.bidirectional}
        roots = [aid for aid in active if aid not in targets]
        return roots[:1] or active[:1]

    def goal_images(self) -> list[dict[str, str]]:
        """Images the user attached to the goal, as model input. Every agent sees them (the builder needs the mock-up as
        much as the CEO does); they sit in the first user message, so they stay in the prompt cache across a tool loop."""
        if self._goal_images is None:
            from app.services.run_attachments import load_images

            try:
                self._goal_images = load_images(self.root, self.run_id, self.attachments)
            except OSError:
                self._goal_images = []
        return self._goal_images

    async def bootstrap(self) -> None:
        content = self.goal
        images = [a for a in self.attachments if a.get("kind") == "image"]
        for att in self.attachments:
            if att.get("kind") != "image":
                content += f"\n\n--- Attached file: {att.get('filename', 'file')} ---\n" + clip(str(att.get("text", "")), 30000)
        if images:
            content += "\n\n--- Attached image(s), shown to every agent as images: " + ", ".join(str(a.get("filename")) for a in images) + " ---"
        meta: dict[str, Any] = {"goal": True}
        if images:
            meta["images"] = [{"filename": a.get("filename"), "name": a.get("name"), "mime": a.get("mime")} for a in images]
        for aid in self.entry_agents():
            await self.post_message(sender="user", from_id=None, to_id=aid, type_="task", content=content, meta=meta)

    async def main(self, fresh: bool = True) -> None:
        try:
            if not any(a.active for a in self.agents.values()):
                await self.finalize("failed", "The company has no active agents")
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
                    if await self.nudge_open_tasks():
                        continue
                    open_ = self.open_tasks()
                    if open_:  # never report success while the board says work is unfinished
                        await self.finalize("incomplete", f"Stalled: {len(open_)} open task(s) and no agent can make progress ("
                                            + "; ".join(f"{t['key']} {t['status']}" for t in open_[:6]) + ")")
                    else:
                        await self.finalize("completed", "Run went quiescent without a final report: no open tasks, no agent has pending work")
                    return
                t0 = self.turn_t0 = time.monotonic()
                try:
                    await self.turn(aid)
                finally:
                    self.turn_t0 = None
                    self.active_seconds += time.monotonic() - t0
                await self.save()
                await self.usage_event()
                if self.finished_summary is not None:
                    open_ = self.open_tasks()
                    await self.finalize("completed", f"Finished with {len(open_)} open task(s): "
                                        + "; ".join(f"{t['key']} {t['status']}" for t in open_[:6]) if open_ else "")
                    return
                if self.loop.escalate() and not self.loop_escalated:
                    self.loop_escalated = True
                    self.paused = True
                    await self.emit("error", {"message": f"Loop detected: agents keep repeating themselves ({self.loop.last_reason or 'repeated messages'}). "
                                                         "Run paused for human review; interject to steer, then resume.", "kind": "loop"})
                await self.check_stall()
        except (StopRun, asyncio.CancelledError):
            await asyncio.shield(self.finalize("cancelled", "Stopped by user (kill switch)"))
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("run_failed", run_id=self.run_id)
            await asyncio.shield(self.finalize("failed", f"{type(exc).__name__}: {exc}"))

    # ------------------------------------------------------------------ a single agent turn
    def blackboard(self) -> str:
        lines = [f"Goal: {clip(self.goal, 6000)}"]
        if self.followups:
            older = len(self.followups) - 5
            lines.append("Follow-up requests from the user (newest last; the earlier work is done, build on it, don't start over):\n"
                         + (f"- ({older} earlier follow-up(s) not shown)\n" if older > 0 else "")
                         + "\n".join(f"- {clip(f, 2000)}" for f in self.followups[-5:]))
        if self.decisions:
            older = len(self.decisions) - 20
            lines.append("Decisions:\n" + (f"- ({older} earlier decision(s) not shown)\n" if older > 0 else "")
                         + "\n".join(f"- {d}" for d in self.decisions[-20:]))
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
        if self.broken_files:
            lines.append("Files FAILING automatic checks (fix before anything else):\n" + "\n".join(
                f"- {p}: {msg.splitlines()[0][:300]}" for p, msg in sorted(self.broken_files.items())))
        if self.user_notes:
            older = len(self.user_notes) - 10
            lines.append("User notes:\n" + (f"- ({older} earlier note(s) not shown)\n" if older > 0 else "")
                         + "\n".join(f"- {n}" for n in self.user_notes[-10:]))
        idle = self.turn_no - self.progress_turn
        lines.append(f"Progress: last file / task-board change at turn {self.progress_turn}"
                     + (f" ({idle} turns ago: deliver something or update the board instead of more discussion)" if idle >= 5 else ""))
        lines.append(f"Budget: turn {self.turn_no}/{self.budget.max_turns}, tokens {self.tokens}/{self.budget.max_tokens}")
        return "\n".join(lines)

    def mock_context(self, agent: AgentSpec, inbox: list[dict[str, Any]], obs: list[dict[str, Any]]) -> dict[str, Any]:
        allowed = allowed_recipients(self.edges, agent.id)
        cat = lambda aid: self.agents[aid].category if aid in self.agents else "user"  # noqa: E731
        return {
            "agent": {"id": agent.id, "name": agent.name, "role": agent.role, "category": agent.category, "is_entry": agent.is_entry,
                      "department": agent.department, "is_manager": agent.is_manager, "tools": agent.tools,
                      "manager": self.names.get(agent.reports_to or ""),
                      "reports": [x.name for x in self.agents.values() if x.reports_to == agent.id and x.active]},
            "goal": self.goal,
            "inbox": [{"from": "user" if m["from"] is None else self.names.get(m["from"], "?"),
                       "from_category": "user" if m["from"] is None else cat(m["from"]),
                       "type": m["type"], "content": m["content"], "verdict": m["meta"].get("verdict"),
                       "comments": m["meta"].get("comments", [])} for m in inbox],
            "observations": obs,
            "allowed": [{"name": self.names[r], "role": self.agents[r].role, "category": self.agents[r].category,
                         "edge_types": [e.type for e in es]} for r, es in allowed.items()],
            "roster": [{"name": a.name, "role": a.role, "category": a.category, "department": a.department, "is_manager": a.is_manager,
                        "active": a.active, "status": self.status.get(a.id, "idle"), "manager": self.names.get(a.reports_to or "")}
                       for a in self.agents.values()],
            "tasks": [{"key": t["key"], "title": t["title"], "assignee": self.names.get(t["assignee"] or "", None), "status": t["status"]}
                      for t in self.tasks.values()],
            "state": self.mock_state.setdefault(agent.id, {}),
        }

    def effort_for(self, agent: AgentSpec) -> str | None:
        """Run override wins, then the agent's setting; None = let the model use its default."""
        e = self.budget.reasoning_effort if self.budget.reasoning_effort != "default" else str(agent.behavior.get("reasoning_effort") or "default")
        if e == "default":
            e = get_settings().default_reasoning_effort or "default"
        return None if e in ("default", "") else e

    async def call_llm(self, agent: AgentSpec, req: LLMRequest) -> str:
        return (await self.call_llm_result(agent, req)).text

    async def call_llm_result(self, agent: AgentSpec, req: LLMRequest) -> LLMResult:
        """Stream one model call: live status + token_stream events, usage accounting, text and (native) tool calls."""
        parts: list[str] = []
        result = LLMResult()
        buf, last = "", time.monotonic()
        speaking = False
        tool_buf = ""  # '"action":"<tool>", <streamed arguments>' so live_activity can describe a native call as it streams
        think: list[str] = []
        think_buf, think_last = "", time.monotonic()
        fresh_call = False
        remaining = max(5.0, self.budget.timeout_s - self.active_now())

        idle: asyncio.Timeout | None = None
        t_start = time.monotonic()

        async def _consume() -> None:
            nonlocal buf, last, speaking, tool_buf, think_buf, think_last, fresh_call
            async for chunk in stream_with_retry(req):
                if idle is not None:  # output is flowing: push the inactivity deadline out (never past the run's budget)
                    left = remaining - (time.monotonic() - t_start)
                    if left <= 0:
                        raise asyncio.TimeoutError("the run's active-time budget ran out during a model call")
                    idle.reschedule(asyncio.get_running_loop().time() + min(LLM_IDLE_TIMEOUT_S, left))
                if chunk.thinking:  # reasoning summary: streamed live as the agent's "thinking"
                    think.append(chunk.thinking)
                    think_buf += chunk.thinking
                    if len(think_buf) >= 60 or time.monotonic() - think_last > 0.15:
                        await self.emit("thinking_stream", {"agent_id": agent.id, "delta": think_buf, "turn_no": self.turn_no})
                        think_buf, think_last = "", time.monotonic()
                    if not speaking:
                        await self.set_agent_status(agent.id, "thinking", "Thinking…")
                if chunk.tool_started:
                    tool_buf = f'"action":"{chunk.tool_started}",'
                    # mark where a new call starts in the live stream, in the same shape as the JSON envelope, so the UI can
                    # show "Writing index.html" + the content instead of raw arguments
                    buf += f'\n{{"action":"{chunk.tool_started}",'
                    fresh_call = True
                    status, activity = live_activity(tool_buf)
                    await self.set_agent_status(agent.id, status, activity)
                if chunk.tool_delta:
                    tool_buf += chunk.tool_delta
                    d = chunk.tool_delta
                    if fresh_call:  # the arguments object's own "{" is already written by the marker above
                        d, fresh_call = d.lstrip().removeprefix("{"), False
                    buf += d
                    if len(buf) >= 120 or time.monotonic() - last > 0.1:
                        status, activity = live_activity(tool_buf[:2000])
                        await self.set_agent_status(agent.id, status, activity)
                        await self.emit("token_stream", {"agent_id": agent.id, "delta": buf, "turn_no": self.turn_no})
                        buf, last = "", time.monotonic()
                if chunk.tool_calls is not None:
                    result.tool_calls = list(chunk.tool_calls)
                if chunk.items is not None:
                    result.items = list(chunk.items)
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
                    self.add_usage(agent.id, chunk.usage)
            if buf:
                await self.emit("token_stream", {"agent_id": agent.id, "delta": buf, "turn_no": self.turn_no})

        # No fixed cap per call: a long reasoning call (xhigh effort, up to 128k output tokens) can legitimately run for many
        # minutes. What counts is silence: if nothing arrives for LLM_IDLE_TIMEOUT_S the call is treated as hung. The run's
        # active-time budget still bounds the whole call.
        try:
            async with asyncio.timeout(min(remaining, LLM_IDLE_TIMEOUT_S)) as idle:
                await _consume()
        except TimeoutError as exc:
            if idle is not None and idle.expired() and not str(exc):
                out_of_budget = time.monotonic() - t_start >= remaining
                raise TimeoutError("the run's active-time budget ran out during a model call" if out_of_budget else
                                   f"no output from the model for {LLM_IDLE_TIMEOUT_S:.0f}s") from exc
            raise
        if think_buf:
            await self.emit("thinking_stream", {"agent_id": agent.id, "delta": think_buf, "turn_no": self.turn_no})
        result.text = "".join(parts)
        result.thinking = "".join(think).strip()
        if result.thinking:  # persisted, so replays and the timeline show what the agent was thinking
            await self.emit("thought", {"agent_id": agent.id, "text": result.thinking[:6000], "turn_no": self.turn_no, "kind": "reasoning"})
        return result

    async def call_llm_escalating(self, agent: AgentSpec, req: LLMRequest) -> str:
        return (await self.call_llm_escalating_result(agent, req)).text

    async def call_llm_escalating_result(self, agent: AgentSpec, req: LLMRequest) -> LLMResult:
        """Call the model; if the reply hits the output limit, raise the agent's budget (and remember it) and retry once."""
        try:
            return await self.call_llm_result(agent, req)
        except LLMOutputTruncated as exc:
            old = req.max_tokens
            new = min(MAX_AGENT_MAX_TOKENS, max(old * 2, CODE_AGENT_MAX_TOKENS))
            if new <= old:
                raise
            await self.raise_output_budget(agent, new, str(exc))
            req.max_tokens = new
            note = {"role": "user", "content": (f"Note: your previous attempt at this reply was cut off at the output limit ({old:,} "
                                                f"tokens) and nothing in it was applied. The limit is now {new:,} tokens.")}
            if req.continuation:  # inside a tool loop the note belongs after the replayed items
                req.continuation = [*req.continuation, note]
            else:
                req.messages = [*req.messages, note]
            return await self.call_llm_result(agent, req)

    async def raise_output_budget(self, agent: AgentSpec, new: int, why: str) -> None:
        old = agent.max_tokens
        agent.max_tokens = new
        snap = self._snapshot_agent(agent.id)
        if snap is not None:
            snap["max_tokens"] = new
            self.snapshot_dirty = True
        persisted = await self._persist_team(updates={agent.id: {"max_tokens": new}}) if self.budget.persist_team else False
        await self.emit("error", {"message": f"{agent.name}: the reply hit the output limit ({old} tokens). Retrying once with {new} tokens"
                                             f"{' and saving the higher limit on the agent' if persisted else ''}. ({why})",
                                  "agent_id": agent.id, "kind": "warning"})

    async def turn(self, aid: str) -> None:
        agent = self.agents[aid]
        inbox_ids = [mid for _, mid in self.mailbox.pop(aid, [])]
        obs = [o for _, o in self.observations.pop(aid, [])]
        self.self_turns[aid] = 0 if inbox_ids else self.self_turns[aid] + 1
        if inbox_ids:
            async with self.db() as db:
                await db.execute(update(Message).where(Message.id.in_(inbox_ids)).values(read=True))
                await db.commit()
        max_auto = int(agent.behavior.get("max_autonomous_turns", 12))
        if self.agent_turns[aid] >= max_auto:  # checked BEFORE counting: a skipped turn costs no budget and is visible
            await self.emit("turn_skipped", {"agent_id": aid, "inbox": inbox_ids, "reason": "max_autonomous_turns", "limit": max_auto})
            await self.emit("error", {"message": f"{agent.name} exceeded max autonomous turns ({max_auto}); its pending work was dropped.",
                                      "agent_id": aid, "kind": "limit"})
            self.done_agents.add(aid)
            await self.set_agent_status(aid, "done")
            return
        self.turn_no += 1
        self.agent_turns[aid] += 1
        self.start_turn_metrics(aid)
        await self.emit("turn_started", {"agent_id": aid, "turn_no": self.turn_no, "inbox": inbox_ids})
        await self.set_agent_status(aid, "thinking", f"Reading {len(inbox_ids)} new message(s)…" if inbox_ids else "Reviewing results…")
        inbox_set = set(inbox_ids)
        inbox = [m for m in self.history if m["id"] in inbox_set]
        try:
            req, native = await self.build_request(agent, inbox_set, obs)
            if native:
                await self.native_turn(agent, req)
                await self.end_turn(aid)
                return
            text = await self.call_llm_escalating(agent, req)
            parsed = A.parse_envelope(text)
            if not parsed.ok and req.provider != "mock":
                req.messages += [{"role": "assistant", "content": head_tail(text, 6000)},
                                 {"role": "user", "content": "Your reply was not valid per the response format ("
                                  + "; ".join(parsed.errors) + "). Reply again with ONLY the JSON object."}]
                text = await self.call_llm_escalating(agent, req)
                parsed = A.parse_envelope(text)
        except LLMOutputTruncated as exc:
            await self.set_agent_status(aid, "error")
            await self.emit("error", {"message": f"{agent.name}: reply cut off at the output limit ({req.max_tokens} tokens): {exc}",
                                      "agent_id": aid, "kind": "llm"})
            self.notice(aid, f"Your previous reply was cut off at the output limit ({req.max_tokens:,} tokens, reasoning included) and "
                             "nothing in it was applied. write_file with \"mode\":\"append\" can build a file across turns.", activate=True)
            await self.requeue(aid, inbox_ids)
            return
        except (LLMError, asyncio.TimeoutError) as exc:
            await self.set_agent_status(aid, "error")
            await self.emit("error", {"message": f"{agent.name}: LLM call failed: {exc}", "agent_id": aid, "kind": "llm"})
            back = await self.requeue(aid, inbox_ids)
            self.notice(aid, f"Your previous turn failed due to a model error ({exc})."
                             + (" The messages from that turn are shown again under NEW messages." if back else ""), activate=bool(inbox_ids))
            return
        if not parsed.ok:
            await self.set_agent_status(aid, "error")
            await self.emit("error", {"message": f"{agent.name} produced an invalid response: {'; '.join(parsed.errors)}", "agent_id": aid, "kind": "parse"})
            await self.requeue(aid, inbox_ids)
            self.notice(aid, "Your last reply could not be parsed: " + "; ".join(parsed.errors) + ". Reply with the JSON object only.", activate=True)
            return
        if parsed.thought:
            await self.emit("thought", {"agent_id": aid, "text": parsed.thought, "turn_no": self.turn_no})
        for err in parsed.errors:
            self.notice(aid, f"Ignored invalid action: {err}", activate=False)
        if parsed.errors:  # the agent may believe it acted: make the drop visible in the run, not just in its next prompt
            await self.emit("error", {"message": f"{agent.name}: ignored {len(parsed.errors)} invalid action(s): {'; '.join(parsed.errors)[:400]}",
                                      "agent_id": aid, "kind": "parse"})
        for action in parsed.actions:
            if self.stop_requested:
                raise StopRun()
            await self.execute(agent, action)
            if self.finished_summary is not None:
                break
        await self.end_turn(aid)

    async def build_request(self, agent: AgentSpec, inbox_ids: set[str], obs: list[dict[str, Any]], *, extra: str = ""
                            ) -> tuple[LLMRequest, bool]:
        """Resolve the model, then build the prompts (native tools or JSON envelope) for one agent turn."""
        aid = agent.id
        inbox = [m for m in self.history if m["id"] in inbox_ids]
        req = LLMRequest(provider=agent.provider, model=agent.model, temperature=agent.temperature, max_tokens=agent.max_tokens,
                         extra={"reasoning_effort": e} if (e := self.effort_for(agent)) else {}, messages=[], json_mode=True,
                         metadata={"kind": "orchestrator", "mock_context": self.mock_context(agent, inbox, obs),
                                   "cache_key": f"octopus-{self.run_id[:18]}-{agent.id}"[:64]})
        if self.budget.force_mock:
            req.provider, req.model = "mock", "mock/demo"
        async with registry_factory()() as rdb:
            req, warn = await prepare_request(rdb, self.user_id, req)
        if warn and aid not in self.warned:
            self.warned.add(aid)
            await self.emit("error", {"message": f"{agent.name}: {warn}", "agent_id": aid, "kind": "warning"})
        native = self.native_tools_for(req)
        system = build_system_prompt(agent, company=self.company_name, goal=self.goal, agents=self.agents, edges=self.edges,
                                     status=self.status, preview_url=self.preview_url(), native=native,
                                     project_memory=PM.render(self.memory, exclude_run=self.run_id))
        user = build_user_prompt(agent=agent, history=self.history, inbox_ids=inbox_ids, observations=obs, blackboard=self.blackboard(),
                                 names=self.names, recent_n=self.budget.context_recent, native=native, digest=self.digest(aid),
                                 team_status=team_status(self.agents, self.status))
        if extra:
            user += "\n\n" + extra
        req.messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        if images := self.goal_images():
            req.images = images
            req.messages[-1]["content"] += (f"\n\n(The user attached {len(images)} image(s) to the goal; they follow this message. "
                                            "Use them as reference for what to build.)")
        self.seen[aid], self.seen_turn[aid] = self.journal_n, self.turn_no
        return req, native

    # ------------------------------------------------------------------ native function calling
    def native_tools_for(self, req: LLMRequest) -> bool:
        """Use the model's own function calling when the provider supports it (Azure Responses API); otherwise the JSON envelope."""
        if not get_settings().native_tools:
            return False
        check = getattr(get_provider(req.provider, req), "supports_native_tools", None)
        return bool(check and check(req))

    async def native_turn(self, agent: AgentSpec, req: LLMRequest, *, exclude: set[str] | frozenset[str] = frozenset()) -> str:
        """One turn as a tool loop: the model calls tools, gets each result back, and keeps going until it stops calling tools
        (or ends the turn with wait / finish / a question for the user). Errors are returned to the model as tool results."""
        aid = agent.id
        specs, mcp_map = T.tool_specs(agent.tools, agent.mcp)
        req.tools = [t for t in specs if t["name"] not in exclude]
        req.json_mode = False
        req.continuation = []
        token = IN_TOOL_LOOP.set(True)
        try:
            return await self._tool_loop(agent, req, mcp_map)
        finally:
            IN_TOOL_LOOP.reset(token)

    async def _tool_loop(self, agent: AgentSpec, req: LLMRequest, mcp_map: dict[str, tuple[str, str]]) -> str:
        aid = agent.id
        last_text = ""
        rounds: list[int] = []  # where each round's items start in req.continuation
        for rnd in range(self.budget.max_tool_rounds):
            if self.stop_requested:
                raise StopRun()
            if rnd and (self.paused or self.limit_reason(turns=False)):
                break  # pause / budget are honoured between rounds too; the turn ends cleanly
            res = await self.call_llm_escalating_result(agent, req)
            if res.text.strip():
                last_text = res.text.strip()
                await self.emit("thought", {"agent_id": aid, "text": last_text[:4000], "turn_no": self.turn_no})
            if not res.tool_calls:
                legacy = A.parse_envelope(res.text) if res.text.lstrip().startswith(("{", "```")) else None
                if legacy and legacy.ok and legacy.actions:  # the model answered with an old-style envelope: honour it
                    for action in legacy.actions:
                        await self.execute(agent, action)
                        if self.finished_summary is not None:
                            break
                break
            outputs: list[dict[str, Any]] = []
            ended = False
            # several delegations in one reply are independent work: run those teammates at the same time
            delegations = [c for c in res.tool_calls if c.name == "delegate"]
            ran: dict[str, tuple[str, bool]] = {}
            if len(delegations) > 1:
                self.metrics["parallel_delegations"] += len(delegations)
                done = await asyncio.gather(*(self.run_tool_call(agent, c, mcp_map) for c in delegations))
                ran = {c.id: r for c, r in zip(delegations, done)}
            for call in res.tool_calls:
                if call.id in ran:
                    out, _ = ran[call.id]
                elif ended:
                    out = "Not run: an earlier call in this reply ended your turn."
                else:
                    out, ended = await self.run_tool_call(agent, call, mcp_map)
                outputs.append({"type": "function_call_output", "call_id": call.id, "output": out})
            left = self.budget.max_tool_rounds - rnd - 1
            if outputs and not ended and left in ROUND_WARNINGS:  # a turn that silently runs out leaves its task half done
                outputs[-1]["output"] += (f"\n\n[Octopus] {left} tool round{'s' if left != 1 else ''} left in this turn. "
                                          + ("Stop exploring: finish the deliverable with what you have, then call `finish` "
                                             "with what's done and what's open." if left > 1 else
                                             "This is your last call: call `finish` now with what's done and what's open."))
            # replay the response (encrypted reasoning included) and answer every call, as the Responses API expects
            replay = [i for i in res.items if not (i.get("type") == "reasoning" and not i.get("encrypted_content"))]
            rounds.append(len(req.continuation))
            req.continuation = compact_rounds([*req.continuation, *replay, *outputs], rounds)
            if ended:
                break
        else:
            await self.emit("error", {"kind": "warning", "agent_id": aid,
                                      "message": f"{agent.name} used all {self.budget.max_tool_rounds} tool rounds of this turn"})
        return last_text

    async def run_tool_call(self, agent: AgentSpec, call: ToolCall, mcp_map: dict[str, tuple[str, str]]) -> tuple[str, bool]:
        """Run one function call through the normal action executor. Returns (result text for the model, turn ended?).

        The executors report back through notices/observations (the envelope path shows those in the next prompt); here
        they are taken out and returned as the call's output instead, so the agent sees them immediately."""
        aid = agent.id
        action, err = T.parse_tool_call(call.name, call.arguments, mcp_map)
        if action is None:
            await self.emit("error", {"message": f"{agent.name}: {call.name}: {err}", "agent_id": aid, "kind": "parse"})
            return f"Error: {err}. Nothing was done; call the tool again with corrected arguments.", False
        if action.action == "delegate":  # returns the teammate's result directly (and may run in parallel with others)
            if not A.tool_enabled(agent.tools, "send_message"):
                return "Error: delegating needs the Messaging tool, which you don't have.", False
            return clip(await self.delegate(agent, action), TOOL_RESULT_CHARS), False
        before = len(self.observations.get(aid, []))
        await self.execute(agent, action)
        produced = self.observations.get(aid, [])[before:]
        if produced:
            del self.observations[aid][before:]
            if not self.observations[aid]:
                self.observations.pop(aid)
        lines = []
        for o in (o for _, o in produced):
            tag = "" if o.get("tool") == "system" else f"[{o.get('tool')}{' OK' if o.get('ok') else ' FAILED' if o.get('ok') is False else ''}] "
            lines.append(tag + str(o.get("content", "")))
        name = action.action
        if not lines:
            if name == "update_task_board":
                lines.append("Task board:\n" + "\n".join(f"- {self.task_line(t)}" for t in self.tasks.values()))
            elif name == "send_message":
                lines.append(f"Sent to {action.to}.")
            else:
                lines.append("Done.")
        ended = (name in T.TERMINAL_ACTIONS or self.finished_summary is not None or aid in self.done_agents
                 or bool(self.awaiting and self.awaiting.get("agent_id") == aid))
        return clip("\n".join(lines), TOOL_RESULT_CHARS), ended

    # ------------------------------------------------------------------ delegation (orchestrator → worker)
    def brief_text(self, delegator: AgentSpec, a: A.Delegate) -> str:
        parts = [f"Objective: {a.objective.strip()}"]
        if a.deliverable.strip():
            parts.append(f"Deliverable: {a.deliverable.strip()}")
        if a.done_when.strip():
            parts.append(f"Done when: {a.done_when.strip()}")
        if a.context.strip():
            parts.append(f"Context: {a.context.strip()}")
        return "\n".join(parts)

    async def act_delegate(self, agent: AgentSpec, a: A.Delegate) -> None:  # JSON-envelope path
        self.notice(agent.id, await self.delegate(agent, a))

    async def delegate(self, agent: AgentSpec, a: A.Delegate) -> str:
        """Hand work to a teammate over a delegate channel. Inside a native tool loop the teammate's sub-turn runs right away
        and its result is returned; otherwise (JSON envelope, or depth/cycle limits) it becomes a task message."""
        tid = self.resolve_agent(a.to)
        if tid is None:
            can = [self.names[r] for r, es in allowed_recipients(self.edges, agent.id).items() if any(e.type == "delegate" for e in es)]
            return f"Not delegated: unknown teammate '{a.to}'. You can delegate to: {', '.join(can) or 'nobody'}."
        if tid == agent.id:
            return "Not delegated: that's you. Just do the work."
        worker = self.agents[tid]
        if not worker.active:
            return f"Not delegated: {worker.name} is inactive."
        edge = find_channel(self.edges, agent.id, tid, "task")
        if edge is None:
            return "Not delegated: " + rejection_reason(self.edges, agent.id, tid, "task", self.names)
        brief = self.brief_text(agent, a)
        frame = DELEGATION.get()
        chain: tuple[str, ...] = (*(frame["chain"] if frame else ()), agent.id)
        self.metrics["delegations"] += 1
        if not IN_TOOL_LOOP.get() or len(chain) > MAX_DELEGATION_DEPTH or tid in chain:
            await self._send_one(agent, tid, A.SendMessage(action="send_message", to=worker.name, type="task", content=brief, task_id=a.task_id))
            return f"Delegated to {worker.name} as a task message; the result arrives as a message when they report back."
        req, native = await self.build_request(worker, set(), [o for _, o in self.observations.pop(tid, [])], extra="")
        if not native:  # e.g. the teammate runs on another provider: fall back to a message
            await self._send_one(agent, tid, A.SendMessage(action="send_message", to=worker.name, type="task", content=brief, task_id=a.task_id))
            return f"Delegated to {worker.name} as a task message; the result arrives as a message when they report back."
        key = await self.link_task(agent.id, tid, a.task_id, a.objective)
        task = self.tasks[key]
        if task["status"] in ("todo", "blocked"):
            task["status"] = "in_progress"
            await self.save_task(task)
        self.edge_counts[edge.id] += 1
        await self.post_message(sender="agent", from_id=agent.id, to_id=tid, type_="task", content=brief, edge_id=edge.id,
                                meta={"task_id": key, "delegation": True}, deliver=False)
        await self.emit("edge_activity", {"edge_id": edge.id, "from_agent_id": agent.id, "to_agent_id": tid, "type": "task",
                                          "count": self.edge_counts[edge.id], "max_turns": int((edge.config or {}).get("max_turns", 20))})
        self.log(agent.id, f"delegated {key} to {worker.name}: {a.objective[:200]}")
        return await self.run_delegated(agent, worker, key, brief, req, chain)

    async def run_delegated(self, delegator: AgentSpec, worker: AgentSpec, key: str, brief: str, req: LLMRequest,
                            chain: tuple[str, ...]) -> str:
        wid = worker.id
        max_auto = int(worker.behavior.get("max_autonomous_turns", 12))
        if self.agent_turns[wid] >= max_auto:
            return f"{worker.name} has no turns left in this request (max {max_auto}); do it yourself or delegate to someone else."
        if (why := self.limit_reason()):
            return f"Not started: {why}"
        self.turn_no += 1
        self.agent_turns[wid] += 1
        self.start_turn_metrics(wid)
        await self.emit("turn_started", {"agent_id": wid, "turn_no": self.turn_no, "inbox": [], "delegated_by": delegator.id, "task": key})
        await self.set_agent_status(wid, "thinking", f"Working on {key} for {delegator.name}…")
        before = {p: v["version"] for p, v in self.artifacts.items()}
        req.messages[-1]["content"] += (f"\n\n# Delegated to you by {delegator.name} (task {key})\n{brief}\n\nYour result goes straight back "
                                        f"to {delegator.name}: when you're done, or can't go on, call `finish` with what you did, where "
                                        "the results are, and anything still open.")
        frame = {"worker": wid, "summary": None, "chain": chain}
        token = DELEGATION.set(frame)
        last = ""
        try:
            last = await self.native_turn(worker, req, exclude={"request_user_input"})
        except (LLMError, asyncio.TimeoutError) as exc:
            last = f"(stopped by a model error: {exc})"
            await self.emit("error", {"message": f"{worker.name}: LLM call failed: {exc}", "agent_id": wid, "kind": "llm"})
        finally:
            DELEGATION.reset(token)
        summary = frame["summary"] or last or "(no summary)"
        task = self.tasks[key]
        if frame["summary"] is not None and task["status"] not in ("done", "blocked"):
            task["status"] = "done"
            await self.save_task(task)
            self.mark_progress()
        changed = [f"{p} (v{v['version']})" for p, v in self.artifacts.items() if before.get(p) != v["version"]]
        await self.end_turn(wid)
        self.log(wid, f"{'finished' if frame['summary'] is not None else 'stopped'} {key} for {delegator.name}: {summary[:200]}")
        await self.post_message(sender="agent", from_id=wid, to_id=delegator.id, type_="status_update", content=summary,
                                meta={"task_id": key, "delegation_result": True}, deliver=False)
        return (f"Result from {worker.name} ({key} is {task['status']}):\n{summary}\n"
                + (f"Files changed: {', '.join(changed)}" if changed else "No files changed."))

    async def act_search_project(self, agent: AgentSpec, a: A.SearchProject) -> None:
        cid = await self._tool_event(agent, "search_project", {"query": a.query, "path_prefix": a.path_prefix})
        await self.set_agent_status(agent.id, "reading", f"Searching for {a.query[:40]}…")
        try:
            hits, total, n = self.fs_for(agent.id).search(a.query, regex=a.regex, prefix=a.path_prefix, max_results=a.max_results)
            out = (f"{total} match{'es' if total != 1 else ''} in {n} files" + (f" (showing {len(hits)})" if total > len(hits) else "")
                   + (":\n" + "\n".join(hits) if hits else "."))
            ok = True
        except WorkspaceError as exc:
            out, ok = str(exc), False
        self.observe(agent.id, {"tool": "search_project", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "search_project", ok, out[:2000])

    def retrospective(self, status: str, reason: str) -> dict[str, Any]:
        open_ = self.open_tasks()
        return {"run_id": self.run_id, "at": utcnow().isoformat(timespec="seconds"), "goal": self.goal[:500], "status": status,
                "halt_reason": reason[:300], "summary": (self.finished_summary or "")[:800],
                "files": sorted(self.artifacts)[:40], "open_tasks": [f"{t['key']} {t['status']} {t['title'][:80]}" for t in open_[:10]],
                "decisions": self.decisions[-5:], "followups": [f[:200] for f in self.followups[-3:]], "efficiency": self.efficiency()}

    async def end_turn(self, aid: str) -> None:
        if self.progress_turn == self.turn_no:  # productive turn: the agent may keep working on its own results
            self.self_turns[aid] = 0
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

    def delegated_message_refusal(self, agent: AgentSpec, a: A.SendMessage) -> str | None:
        """Inside a delegated sub-turn nobody can answer in time (answers arrive as later turns, after this one has ended),
        and the `finish` summary already goes back to the delegator. Questions and progress reports there only cost turns:
        in practice the builder asked design/QA questions, built anyway, and the answers landed after it was done."""
        frame = DELEGATION.get()
        if frame is None or frame["worker"] != agent.id:
            return None
        boss = self.names.get(frame["chain"][-1], "your delegator") if frame["chain"] else "your delegator"
        if a.type == "question":
            return (f"You are working on a task {boss} delegated to you: an answer would only arrive after this turn has ended. "
                    "Check the Blackboard and the files, make a sensible assumption and name it in your `finish` summary, "
                    "or `finish` now and say exactly what is blocking.")
        if a.type in ("status_update", "final_report") and self.resolve_agent(a.to.strip()) == (frame["chain"] or ("",))[-1]:
            return f"Not needed: your `finish` summary goes straight back to {boss}. Keep working, then call `finish`."
        return None

    async def reject(self, agent: AgentSpec, to_id: str | None, a: A.SendMessage, reason: str, *, retry: bool = True) -> None:
        """``retry=False`` for loop / channel-limit rejections: the agent sees the notice next time it is woken, but the
        rejection itself does not buy it another turn (that just turned a loop into a spin)."""
        self.rejections += 1
        self.notice(agent.id, f"Message to {self.names.get(to_id or '', a.to)} was REJECTED: {reason}", activate=retry)
        await self.emit("message_rejected", {"from_agent_id": agent.id, "to_agent_id": to_id, "to": a.to, "type": a.type,
                                             "reason": reason, "content": a.content[:300]})

    async def act_send_message(self, agent: AgentSpec, a: A.SendMessage) -> None:
        to = a.to.strip()
        if (why := self.delegated_message_refusal(agent, a)):
            await self.reject(agent, self.resolve_agent(to), a, why, retry=False)
            return
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
        if not self.agents[tid].active:
            await self.reject(agent, tid, a, f"{self.names[tid]} is inactive (deactivated). Use list_agents to find an active teammate.")
            return
        edge = find_channel(self.edges, agent.id, tid, a.type)
        if edge is None:
            await self.reject(agent, tid, a, rejection_reason(self.edges, agent.id, tid, a.type, self.names))
            return
        cfg = edge.config or {}
        max_turns = int(cfg.get("max_turns", 20))
        if self.edge_counts[edge.id] >= max_turns:
            await self.reject(agent, tid, a, f"Channel turn limit reached (max_turns={max_turns}). Wrap up or escalate via another channel.",
                              retry=False)
            return
        if self.loop.check(agent.id, tid, a.type, a.content):
            await self.reject(agent, tid, a, f"Loop detected: {self.loop.last_reason}. {self.names[tid]} already has it. Don't ask again: "
                                             "check the Blackboard (task board, workspace files), do the work yourself, escalate, or finish.",
                              retry=False)
            await self.emit("error", {"message": f"Loop detector: {agent.name} → {self.names[tid]}: {self.loop.last_reason}",
                                      "agent_id": agent.id, "kind": "loop"})
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
                self.decide(f"Consensus ({self.names[edge.source]} ↔ {self.names[edge.target]}): {st.outcome[:240]}", agent.id)
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
            self.decide(f"Decision by {agent.name}: {content.splitlines()[0][:240]}", agent.id)
        if a.type == "decision" or (protocol_event and protocol_event.get("result") not in (None, "requested", "round")):
            self.mark_progress()  # verdicts, consensus and decisions move the run forward; another debate round does not
        if protocol_event:
            state = self.debates[edge.id].to_dict() if protocol_event["kind"] == "debate" else self.reviews[f"{edge.id}:{agent.id if a.type == 'review_request' else tid}"].to_dict()
            await self.emit("protocol", {**protocol_event, "edge_id": edge.id, "state": state})
        for pid, text in notices.items():
            self.notice(pid, text, activate=activating)

    async def condition_met(self, agent: AgentSpec, edge: EdgeSpec, a: A.SendMessage) -> bool:
        """Evaluate a natural-language edge condition with a tiny LLM judge call (mock: always satisfied)."""
        cond = edge.config.get("condition", "")
        req = LLMRequest(provider=agent.provider, model=agent.model, temperature=0, max_tokens=JUDGE_MAX_TOKENS,
                         extra={"reasoning_effort": "low" if self.effort_for(agent) != "none" else "none"}, messages=[
            {"role": "system", "content": "You are a strict gatekeeper. Answer only YES or NO."},
            {"role": "user", "content": f"Channel condition: {cond}\nBlackboard:\n{clip(self.blackboard(), 8000)}\n\n"
                                        f"Message ({a.type}): {clip(a.content, 6000)}\n\nIs the condition satisfied?"}],
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
                    self.add_usage(agent.id, ch.usage)
            verdict = judge_verdict(out)
            if verdict is not None:
                return verdict
            why = f"unclear answer {out.strip()[:40]!r}" if out.strip() else "no answer"
        except LLMError as exc:
            why = f"judge failed: {exc}"
        # Fail open (a broken judge must not block the run) but never silently: a non-answer is "unknown", not "yes".
        await self.emit("error", {"message": f"Channel condition \"{cond}\" could not be evaluated ({why}); the message was delivered.",
                                  "agent_id": agent.id, "kind": "warning"})
        return True

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
        self.log(creator, f"created {t['key']} \"{t['title'][:120]}\"" + (f" for {self.names.get(t['assignee'], '?')}" if t["assignee"] else ""))
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
                before = (t["status"], t["assignee"])
                for f, v in (("title", item.title), ("description", item.description), ("status", item.status), ("acceptance_criteria", ac)):
                    if v is not None:
                        t[f] = v
                if assignee:
                    t["assignee"] = assignee
                if (t["status"], t["assignee"]) != before:
                    self.mark_progress()
                await self.save_task(t)
                changed.append(f"{key} → {t['status']}")
            elif item.title:
                t = await self.create_task(agent.id, {"title": item.title, "description": item.description, "assignee": assignee,
                                                      "status": item.status, "acceptance_criteria": ac})
                self.mark_progress()
                changed.append(f"created {t['key']}")
            else:
                self.notice(agent.id, f"Unknown task key '{item.key}'. Existing: {', '.join(self.tasks) or 'none'}")
        moved = [c for c in changed if not c.startswith("created")]
        if moved:
            self.log(agent.id, "task board: " + ", ".join(moved))
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
        appending = a.mode == "append"
        content = (old or "") + a.content if appending else a.content
        await self.commit_file(agent, cid, "write_file", rel, old, content, a.note, appending=appending, partial=a.partial)

    async def act_edit_file(self, agent: AgentSpec, a: A.EditFile) -> None:
        """Targeted change: each edit replaces exact existing text. All edits apply, or none do."""
        cid = await self._tool_event(agent, "edit_file", {"path": a.path, "edits": len(a.edits), "note": a.note})
        fs = self.fs_for(agent.id)
        try:
            rel, _ = fs.resolve(a.path)
            old = fs.current(rel)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "edit_file", f"edit_file failed: {exc}")
            return
        if old is None:
            await self.deny(agent, cid, "edit_file", f"edit_file failed: {rel} does not exist (create it with write_file)")
            return
        try:
            content, first_line = apply_edits(old, a.edits)
        except ValueError as exc:
            await self.deny(agent, cid, "edit_file", f"edit_file failed on {rel}: {exc}. The file was not changed.")
            return
        await self.commit_file(agent, cid, "edit_file", rel, old, content, a.note, context_line=first_line)

    async def commit_file(self, agent: AgentSpec, cid: str, tool: str, rel: str, old: str | None, content: str, note: str, *,
                          appending: bool = False, partial: bool = False, context_line: int | None = None) -> None:
        """Permission gate, write, version history, events and the agent's confirmation, shared by write_file / edit_file.
        One writer per path at a time (parallel delegations may touch the same file)."""
        async with self.file_lock(rel):
            await self._commit_file(agent, cid, tool, rel, old, content, note, appending=appending, partial=partial,
                                    context_line=context_line)

    async def _commit_file(self, agent: AgentSpec, cid: str, tool: str, rel: str, old: str | None, content: str, note: str, *,
                           appending: bool = False, partial: bool = False, context_line: int | None = None) -> None:
        fs = self.fs_for(agent.id)
        if tool == "edit_file" or appending:  # the file may have changed while waiting for the lock: re-apply on current content
            current = fs.current(rel)
            if current != old:
                await self.deny(agent, cid, tool, f"{tool} failed: {rel} was changed by a teammate meanwhile; read it again")
                return
        if old == content:
            self.notice(agent.id, f"{rel} unchanged ({'nothing to append' if appending else 'identical content'}).")
            await self._tool_result(agent, cid, tool, True, "unchanged")
            return
        planned = fs.shadow is not None
        action = "edit" if tool == "edit_file" else "append to" if appending and old is not None else ("create" if old is None else "modify")
        ok, reason = await self.guard(agent, "write_file", f"{agent.name} wants to {action} {rel}",
                                      content, {"path": rel, "old": (old or "")[:20000], "new": content[:20000], "note": note})
        if not ok:
            await self.deny(agent, cid, tool, reason)
            return
        await self.set_agent_status(agent.id, "writing", f"{'Editing' if tool == 'edit_file' else 'Appending to' if appending else 'Saving'} {rel}…")
        try:
            fs.write(rel, content)
        except WorkspaceError as exc:
            await self.deny(agent, cid, tool, f"{tool} failed: {exc}")
            return
        self.mark_progress()
        if not rel.startswith(PROJECT_DIRNAME + "/"):  # a deliverable (not a working doc)
            self.mark_work(agent.id)
            if self.first_deliverable_turn is None:
                self.first_deliverable_turn = self.turn_no
        prev = self.artifacts.get(rel)
        if old is not None and prev is None and not planned and not await self.written_by_octopus(rel):
            # never silently overwrite the user's own file (whatever the permission level): say so, loudly
            await self.emit("error", {"kind": "warning", "agent_id": agent.id, "path": rel, "message": (
                f"{agent.name} changed {rel}, a file that existed before Octopus touched it. "
                "The original is kept: revert it from Artifacts → Run changes.")})
        version = (prev or {}).get("version", 0) + 1
        art = Artifact(id=new_id(), run_id=self.run_id, path=rel, content=content, version=version, author_agent_id=agent.id,
                       change_note=note[:1000], planned=planned, created_at=utcnow(),
                       previous_content=(fs.original(rel) if planned else old) if prev is None else None)
        async with self.db() as db:
            db.add(art)
            await db.commit()
        added = content.count("\n") + 1
        removed = (old or "").count("\n") + 1 if old else 0
        self.artifacts[rel] = {"version": version, "author": agent.id, "note": note}
        await self.emit("artifact_updated", {"artifact": {"id": art.id, "run_id": self.run_id, "path": rel, "version": version,
                                                          "author_agent_id": agent.id, "change_note": note, "size": len(content),
                                                          "planned": planned, "created": old is None, "appended": appending,
                                                          "edited": tool == "edit_file", "lines": added, "previous_lines": removed,
                                                          "created_at": art.created_at.isoformat()}})
        verb = "Planned" if planned else ("Created" if old is None else "Edited" if tool == "edit_file" else "Appended to" if appending else "Updated")
        self.log(agent.id, f"{verb.lower()} {rel} (v{version})" + (f": {note[:200]}" if note else ""))
        await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                                content=f"{verb} `{rel}` (v{version})" + (f": {note}" if note else ""),
                                meta={"path": rel, "version": version, "artifact_id": art.id, "planned": planned}, deliver=False)
        size_note = (f" It now has {added} lines; append the next part now (mode \"append\")." if partial
                     else f" It now has {added} lines." if appending else "")
        if context_line is not None:  # show the edited region so the agent can check the result without re-reading the file
            size_note = f" Lines around the change:\n{numbered_excerpt(content, context_line)}"
        problem = None if partial else await self.check_written(rel, content)
        self.notice(agent.id, f"{verb} {rel} (v{version}).{size_note}"
                    + (" (plan mode: saved as a proposal, the project is unchanged)" if planned else "")
                    + (f"\n\nAUTOMATIC CHECK FAILED for {rel}:\n{problem}\nFix this before anything else." if problem else ""),
                    activate=partial or bool(problem))
        await self._tool_result(agent, cid, tool, True, f"{rel} v{version}{' (appended)' if appending else ''}{' (planned)' if planned else ''}")

    async def check_written(self, rel: str, content: str) -> str | None:
        """Syntax-check a file right after it was written (services/checks.py); remembered until a later write fixes it."""
        from app.services.checks import check_file

        try:
            problem = await check_file(rel, content)
        except Exception as exc:  # noqa: BLE001 - a checker bug must never fail the write
            log.warning("file_check_failed", path=rel, error=str(exc)[:200])
            return None
        if problem:
            self.broken_files[rel] = problem[:1500]
        else:
            self.broken_files.pop(rel, None)
        return problem

    async def written_by_octopus(self, rel: str) -> bool:
        """Did any run in this project ever write ``rel``? (Otherwise it is the user's own file.)"""
        async with self.db() as db:
            return (await db.execute(select(Artifact.id).where(Artifact.path == rel).limit(1))).first() is not None

    async def act_create_folder(self, agent: AgentSpec, a: A.CreateFolder) -> None:
        cid = await self._tool_event(agent, "create_folder", {"path": a.path})
        fs = self.fs_for(agent.id)
        try:
            rel, real = fs.resolve(a.path)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "create_folder", f"create_folder failed: {exc}")
            return
        if real.is_dir():
            self.notice(agent.id, f"Folder {rel}/ already exists.")
            await self._tool_result(agent, cid, "create_folder", True, "exists")
            return
        ok, reason = await self.guard(agent, "write_file", f"{agent.name} wants to create the folder {rel}/", f"mkdir {rel}",
                                      {"path": rel + "/", "old": "", "new": "", "note": a.note or "new folder"})
        if not ok:
            await self.deny(agent, cid, "create_folder", reason)
            return
        try:
            fs.make_dir(rel)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "create_folder", f"create_folder failed: {exc}")
            return
        planned = fs.shadow is not None
        self.mark_progress()
        await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                                content=f"{'Planned' if planned else 'Created'} folder `{rel}/`" + (f": {a.note}" if a.note else ""),
                                meta={"path": rel + "/", "folder": True, "planned": planned}, deliver=False)
        await self.emit("folder_created", {"path": rel, "agent_id": agent.id, "planned": planned})
        self.notice(agent.id, f"Created folder {rel}/.")
        await self._tool_result(agent, cid, "create_folder", True, f"{rel}/")

    async def act_move_file(self, agent: AgentSpec, a: A.MoveFile) -> None:
        cid = await self._tool_event(agent, "move_file", {"source": a.source, "destination": a.destination})
        fs = self.fs_for(agent.id)
        try:
            src, _ = fs.resolve(a.source)
            dst, _ = fs.resolve(a.destination)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "move_file", f"move_file failed: {exc}")
            return
        ok, reason = await self.guard(agent, "write_file", f"{agent.name} wants to move {src} → {dst}", f"mv {src} {dst}",
                                      {"path": f"{src} → {dst}", "old": "", "new": "", "note": a.note or "move / rename"})
        if not ok:
            await self.deny(agent, cid, "move_file", reason)
            return
        await self.set_agent_status(agent.id, "writing", f"Moving {src} → {dst}…")
        try:
            src, dst, moved = fs.move(src, dst)
        except WorkspaceError as exc:
            await self.deny(agent, cid, "move_file", f"move_file failed: {exc}")
            return
        self.mark_progress()
        # keep the run's file list in step with the project
        for old_path in [p for p in list(self.artifacts) if p == src or p.startswith(src + "/")]:
            self.artifacts[dst + old_path[len(src):]] = self.artifacts.pop(old_path)
        await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="artifact_created",
                                content=f"Moved `{src}` → `{dst}`" + (f" ({len(moved)} files)" if len(moved) > 1 else "") + (f": {a.note}" if a.note else ""),
                                meta={"path": dst, "moved_from": src, "moved": moved[:200]}, deliver=False)
        await self.emit("file_moved", {"source": src, "destination": dst, "files": moved[:200], "agent_id": agent.id})
        self.notice(agent.id, f"Moved {src} → {dst} ({len(moved)} file{'s' if len(moved) != 1 else ''}).")
        await self._tool_result(agent, cid, "move_file", True, f"{src} → {dst}")

    async def act_read_file(self, agent: AgentSpec, a: A.ReadFile) -> None:
        cid = await self._tool_event(agent, "read_file", {"path": a.path})
        await self.set_agent_status(agent.id, "reading", f"Reading {a.path}…")
        try:
            content = self.fs_for(agent.id).read(a.path)
            ok = True
        except WorkspaceError as exc:
            content, ok = str(exc), False
        header = f"{a.path}:"
        if ok and (a.offset or len(content) > READ_PAGE_CHARS):  # page big files explicitly instead of a silent cut
            end = min(len(content), a.offset + READ_PAGE_CHARS)
            more = f"; read_file with \"offset\": {end} for the next part" if end < len(content) else " (end of file)"
            header = f"{a.path} [characters {a.offset:,}-{end:,} of {len(content):,}{more}]:"
            content = content[a.offset:end]
        self.observe(agent.id, {"tool": "read_file", "ok": ok, "content": f"{header}\n{content}"})
        await self._tool_result(agent, cid, "read_file", ok, content[:1000])

    async def act_list_files(self, agent: AgentSpec, a: A.ListFiles) -> None:
        cid = await self._tool_event(agent, "list_files", {"prefix": a.prefix})
        await self.set_agent_status(agent.id, "reading", f"Listing {a.prefix or 'project'} files…")
        try:
            fs = self.fs_for(agent.id)
            files = fs.list(a.prefix.strip().strip("/"))
            if not a.prefix.strip().strip("/"):  # the whole project: working documents too (they live in .octopus/work/)
                files += fs.list_work()
            out, ok = ("\n".join(files[:400]) + (f"\n… {len(files) - 400} more" if len(files) > 400 else "")) or "(no files)", True
        except WorkspaceError as exc:
            out, ok = str(exc), False
        self.observe(agent.id, {"tool": "list_files", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "list_files", ok, out[:2000])

    def preview_url(self) -> str:
        """Where the agents' browser can open this project (served by Octopus, sandboxed)."""
        return f"{get_settings().public_url.rstrip('/')}/api/v1/w/{self.project.workspace_id}/preview/"

    async def load_mcp(self) -> None:
        """Resolve MCP servers granted to each agent (only the run owner's registered, enabled servers)."""
        from app.models import McpServer
        from app.tools.mcp_client import McpConfig

        from app.services.browser import SERVER_ID, SERVER_NAME, browser

        wanted = {sid for a in self.agents.values() for sid in (a.tools.get("mcp_servers") or [])}
        if wanted:
            async with registry_factory()() as rdb:
                rows = (await rdb.execute(select(McpServer).where(McpServer.id.in_(wanted), McpServer.user_id == self.user_id,
                                                                  McpServer.enabled.is_(True)))).scalars().all()
            self.mcp_configs = {r.id: McpConfig.from_row(r) for r in rows}
        for a in self.agents.values():
            a.mcp = [{"id": c.id, "name": c.name, "tools": c.tools} for sid in (a.tools.get("mcp_servers") or [])
                     if (c := self.mcp_configs.get(sid)) and c.name.lower() != SERVER_NAME]
            if A.tool_enabled(a.tools, "browser") and get_settings().browser_enabled:
                a.mcp.append({"id": SERVER_ID, "name": SERVER_NAME, "tools": browser.tool_list(), "builtin": True})

    async def _browser_action(self, agent: AgentSpec, cid: str, a: A.McpCall, ok: bool, out: str) -> None:
        """Record what the agent did in its browser tab and what the tab showed afterwards (the run's Browser view)."""
        from app.services import browser_frames
        from app.services.browser import browser, page_info

        url, title = page_info(out)
        if url:
            self.browser_pages[agent.id] = (url, title)
        else:
            url, title = self.browser_pages.get(agent.id, ("", ""))
        frame = None
        if ok and get_settings().browser_live_frames:
            data = await browser.frame(self.run_id, agent.id, a.tool)
            if data:
                try:
                    frame = browser_frames.save(self.run_id, data)
                except (OSError, ValueError) as exc:
                    log.warning("browser_frame_not_saved", error=str(exc))
        args = {k: (v[:300] if isinstance(v, str) else v) for k, v in (a.arguments or {}).items()}
        await self.emit("browser_action", {"agent_id": agent.id, "call_id": cid, "tool": a.tool, "args": args, "ok": ok,
                                           "url": url, "title": title[:200], "frame": frame,
                                           "note": "" if ok else out[:500], "turn_no": self.turn_no})

    async def act_mcp_call(self, agent: AgentSpec, a: A.McpCall) -> None:
        from app.tools.mcp_client import call_tool

        cid = await self._tool_event(agent, f"mcp:{a.server}/{a.tool}", {"server": a.server, "tool": a.tool, "arguments": a.arguments})
        from app.services.browser import SERVER_ID, browser

        granted = {m["name"].lower(): m["id"] for m in agent.mcp}
        sid = granted.get(a.server.lower())
        if sid == SERVER_ID:  # built-in browser: one persistent tab per agent, no approval needed (isolated, in-memory profile)
            if self.levels.get(agent.id, self.level) == "read_only" and a.tool in ("browser_fill_form", "browser_type", "browser_file_upload"):
                await self.deny(agent, cid, "mcp_call", "Read-only mode: you may look at pages but not fill in forms.")
                return
            await self.set_agent_status(agent.id, "tool", f"Browser: {a.tool.removeprefix('browser_')}…")
            self.mark_work(agent.id)
            ok, out = await browser.call(self.run_id, agent.id, a.tool, a.arguments)
            if not ok and not browser.available():
                out += ("\nThe browser can't run in this environment: don't retry it. Verify by reading the code instead, and say in "
                        "your report that nothing was tested in a real browser.")
                if "browser" not in self.warned:
                    self.warned.add("browser")
                    await self.emit("error", {"kind": "warning", "agent_id": agent.id, "message": (
                        "The built-in browser is unavailable, so this run can only check the project by reading its source; "
                        f"'it works in the browser' is unverified. {browser.error.splitlines()[0] if browser.error else ''}")})
            self.observe(agent.id, {"tool": f"browser/{a.tool}", "ok": ok, "content": out})
            await self._tool_result(agent, cid, "mcp_call", ok, out)
            await self._browser_action(agent, cid, a, ok, out)
            return
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
        self.mark_work(agent.id)
        ok, out = await call_tool(cfg, a.tool, a.arguments)
        self.observe(agent.id, {"tool": f"mcp:{cfg.name}/{a.tool}", "ok": ok, "content": out})
        await self._tool_result(agent, cid, "mcp_call", ok, out)

    async def act_run_code(self, agent: AgentSpec, a: A.RunCode) -> None:
        self.mark_work(agent.id)
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
        cid = await self._tool_event(agent, "remember", {"key": a.key, "scope": a.scope})
        if a.scope == "project":  # shared with the whole team, now and in future runs (.octopus/memory.json)
            try:
                self.memory = PM.remember(self.root, a.key, a.value, agent.name)
                ok = True
            except OSError:
                ok = False
            self.log(agent.id, f"project memory: {a.key} = {a.value[:200]}")
            await self._tool_result(agent, cid, "remember", ok, a.key)
            return
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
        options = [o.model_dump() for o in a.options]
        rec = await self.post_message(sender="agent", from_id=agent.id, to_id=None, type_="question", content=a.question,
                                      meta={"awaiting_input": True, "options": options, "allow_other": True}, deliver=False)
        self.awaiting = {"agent_id": agent.id, "question": a.question, "message_id": rec["id"], "options": options, "allow_other": True}
        await self.set_agent_status(agent.id, "waiting")

    async def act_finish(self, agent: AgentSpec, a: A.Finish) -> None:
        frame = DELEGATION.get()
        if frame is not None and frame["worker"] == agent.id:  # a delegated sub-turn: hand the result back to the delegator
            frame["summary"] = a.summary or "Done."
            return
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
            self.mark_progress()
            self.log(agent.id, f"finished: {(a.summary or '')[:300]}")
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
        try:  # what this run did, for the agents of the next run in this project
            self.memory = PM.add_run(self.root, self.retrospective(status, reason))
        except OSError:  # pragma: no cover
            log.warning("project_memory_write_failed", run_id=self.run_id)
        async with self.db() as db:
            await db.execute(update(Run).where(Run.id == self.run_id).values(
                status=status, halt_reason=reason[:200], summary=summary, ended_at=utcnow(),
                tokens_used=self.tokens, cost_usd=round(self.cost, 6), turns=self.turn_no, state_json=self.state_dict()))
            await db.commit()
        from app.services.browser import browser
        from app.services.report import build_report  # local import avoids a cycle

        await browser.close_run(self.run_id)

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

    async def continue_run(self, run_id: str, project: ProjectRef, content: str, to_agent_id: str | None = None) -> RunRuntime | None:
        """Send a message to a run. Live runs get an interjection; finished runs are re-opened and continue with full context."""
        rt = await self.ensure(run_id, project)
        if rt is not None:
            if rt.finalized or rt.run_status in TERMINAL_STATES:
                return None  # finishing right now; caller retries
            await rt.interject(content, to_agent_id)
            return rt
        loaded = await self._load(run_id, project)
        if not loaded:
            return None
        run, user_id = loaded
        rt = RunRuntime(run, user_id, project)
        await rt.restore(run)
        rt.mailbox.clear()  # stale unread messages from the finished run are context, not new work
        await rt.load_mcp()
        self.runtimes[run_id] = rt
        await rt.continue_with(content, to_agent_id)
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
