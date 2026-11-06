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
import re
import time
import types
from collections import Counter
from typing import TYPE_CHECKING, Any


from app.foundation.config import get_settings
from app.foundation.logging import get_logger
from app.kernel.current import current
from app.kernel.policy import PolicyGate
from app.kernel.run_manager import ProjectRef
from app.kernel.runtime import board, lifecycle, mailbox, run_control, run_state, turn_loop
from app.kernel.runtime.context import build_turn_prompts
from app.kernel.runtime.execution import ExecutionService, execution_field
from app.kernel.runtime.loopguard import LoopDetector
from app.kernel.runtime.nullflow import FLOW_METHODS, ORG_METHODS, NullFlow, NullOrg
from app.sdk import actions as A
from app.sdk.agents import AgentSpec, role_category
from app.sdk.approval_modes import normalize_mode
from app.sdk.evidence import redact_evidence
from app.sdk.execution_contracts import ACTIVE_ATTEMPT, mutation_lock
from app.sdk.llm import CODE_AGENT_MAX_TOKENS, MAX_AGENT_MAX_TOKENS, LLMOutputTruncated, LLMRequest, LLMResult
from app.sdk.projectfs import ProjectFS
from app.sdk.protocols import DebateState, ReviewState
from app.sdk.routing import EdgeSpec
from app.sdk.schemas import RunBudget
from app.storage.base import new_id
from app.storage.models import Message, Run, Task
from app.storage.repositories import CompanyRepository, RunRepository

if TYPE_CHECKING:  # pragma: no cover
    from app.kernel.core import Kernel


log = get_logger("orchestrator")


TERMINAL_STATES = {"completed", "incomplete", "failed", "cancelled"}


# A model call is only treated as hung after this long with *no* output (reasoning summaries, text or tool arguments).
# There is no fixed cap on a call that keeps streaming: xhigh reasoning with a 128k output budget can take many minutes.
LLM_IDLE_TIMEOUT_S = 300.0


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




class RunRuntime:
    runtime_store = execution_field("runtime_store")
    plan_revision = execution_field("plan_revision")
    engineering_workflow = execution_field("engineering_workflow")
    pinned_workflow = execution_field("pinned_workflow")
    pinned_skills = execution_field("pinned_skills")
    pinned_guidance = execution_field("pinned_guidance")
    pinned_roles = execution_field("pinned_roles")
    execution_records = execution_field("execution_records")
    worker_sessions = execution_field("worker_sessions")
    worker_session_history = execution_field("worker_session_history")
    engineering_checkpoints = execution_field("engineering_checkpoints")
    acceptance_nudges = execution_field("acceptance_nudges")
    observed_checks = execution_field("observed_checks")
    task_turns = execution_field("task_turns")
    _proof_environment = execution_field("_proof_environment")
    _last_manifest = execution_field("_last_manifest")

    def __init__(self, run: Run, user_id: str, project: ProjectRef, *, kernel: Kernel | None = None) -> None:
        self.kernel = kernel if kernel is not None else current()
        self.services = self.kernel.services
        org, flow = self.services.get("workflow.org"), self.services.get("workflow.company")
        self.org = org.OrgService(self) if org is not None else NullOrg()  # a disabled workflow plugin leaves a neutral stand-in
        self.flow = flow.CompanyWorkflow(self) if flow is not None else NullFlow()
        snap = run.snapshot_json or {}
        self.snapshot: dict[str, Any] = {"company": snap.get("company") or {}, "agents": list(snap.get("agents") or []),
                                         "edges": list(snap.get("edges") or []), "departments": dict(snap.get("departments") or {})}
        self.snapshot_dirty = False
        self.company_id = run.company_id
        self.project = project
        self.sf = project.sf
        self.level = normalize_mode(run.permission_level)
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
        self.agent_state: dict[str, dict[str, Any]] = {}
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

        self.seq = 0
        self.turn_no = run.turns or 0
        self.tokens = run.tokens_used or 0
        self.cost = run.cost_usd or 0.0
        self.active_seconds = 0.0
        builtin_roles, skills = self.services.get("roles.builtin"), self.services.get("skills.library")
        self.roles = builtin_roles.all_roles() if builtin_roles is not None else {}  # replaced by the owner's role library in load_roles()
        self.skills: dict[str, Any] = skills.builtin_skills() if skills is not None else {}  # + the owner's and the project's skills in load_roles()
        self.broken_files: dict[str, str] = {}  # path → the failed automatic check of its latest version
        self.wf: dict[str, Any] | None = None  # the workflow's state (orchestrator/workflow.py); None = free-form run
        # verify-before-finish: code changed since anything was last run / opened in the browser
        self.unverified: dict[str, int] = {}  # deliverable path → turn it last changed without being exercised since
        self.finish_bounces: set[str] = set()  # "agent|files" already sent back once (never twice for the same state)
        self._bounced_finish: str | None = None
        self.turn_t0: float | None = None  # monotonic start of the top-level turn in progress (counted live by the time limit)
        self.run_status = run.status

        self.wake = asyncio.Event()
        self.paused = False
        self.step_credits = 0
        self.stop_requested = False
        self.awaiting: dict[str, Any] | None = None
        self.finished_summary: str | None = None
        self.finalized = False
        self.task: asyncio.Task[None] | None = None
        self.root = project.root
        self._fs: dict[str, Any] = {}
        self.mcp_configs: dict[str, Any] = {}
        self.activity: dict[str, str] = {}
        self.policy = PolicyGate(self)
        self.execution = ExecutionService(self)
        self.execution.init_execution(run)

    def db(self):  # type: ignore[no-untyped-def]
        return self.sf()

    def __getattr__(self, name: str) -> Any:
        """Methods that enabled plugins registered for every run (HostApi.add_run_methods)."""
        if name.startswith("__") or "kernel" not in self.__dict__:
            raise AttributeError(name)
        method = self.kernel.run_methods.get(name)
        if method is None:
            raise AttributeError(f"{type(self).__name__!r} object has no attribute {name!r} (no enabled plugin provides it)")
        return types.MethodType(method, self)

    def tool_available(self, name: str) -> bool:
        """Can an action of this name run? The kernel's own actions always can; plugin actions while their plugin is enabled."""
        return getattr(self.execution, f"act_{name}", None) is not None or self.kernel.tools.has(name)

    def mutation_lock(self) -> asyncio.Lock:
        return mutation_lock(self.run_id)

    def build_turn_prompts(self, agent: AgentSpec, inbox_ids: set[str], observations: list[dict[str, Any]], *, native: bool,
                           memory_context: str) -> tuple[str, str]:
        """The system and user prompt of one turn. Every worker backend (native tools, JSON envelope, OpenCode) uses the same."""
        return build_turn_prompts(self, agent, inbox_ids, observations, native=native, memory_context=memory_context)

    def fs_for(self, aid: str) -> Any:
        root = self.execution.worker_root(aid)
        key = str(root)
        if key not in self._fs:
            self._fs[key] = ProjectFS(root)
        return self._fs[key]

    async def emit(self, type_: str, data: dict[str, Any]) -> None:
        if type_ not in ("run_status", "error", "usage_update", "agent_status", "attempt_updated"):
            self.execution.assert_current_attempt()
        if type_ in ("tool_call", "tool_result", "thought", "error"):
            def filtered(value):
                if isinstance(value, str):
                    return redact_evidence(value)
                if isinstance(value, list):
                    return [filtered(item) for item in value]
                if isinstance(value, dict):
                    return {key: filtered(item) for key, item in value.items()}
                return value
            data = filtered(data)
        await self.kernel.eventlog.publish(self.run_id, type_, data, self.sf)

    @staticmethod
    def _rec(m: Message) -> dict[str, Any]:
        return {"id": m.id, "from": m.from_agent_id, "to": m.to_agent_id, "type": m.type, "content": m.content,
                "turn": m.turn_no, "edge_id": m.edge_id, "meta": m.meta_json or {}, "sender": m.sender}

    @staticmethod
    def _task_dict(t: Task) -> dict[str, Any]:
        return {"id": t.id, "key": t.key, "title": t.title, "description": t.description, "assignee": t.assignee_agent_id,
                "status": t.status, "acceptance_criteria": t.acceptance_criteria, "created_by": t.created_by,
                "constraints_json": t.constraints_json or {}}

    @property
    def pending_approval(self) -> dict[str, Any] | None:
        return self.policy.pending_approval

    def resolve_approval(self, approval_id: str, approved: bool, reason: str, scope: str = "once") -> bool:
        return self.policy.resolve(approval_id, approved, reason, scope)

    async def request_approval(self, agent: AgentSpec, kind: str, summary: str, preview: str,
                               details: dict[str, Any] | None = None) -> tuple[bool, str]:
        return await self.policy.request_approval(agent.id, kind, summary, preview, details)

    async def guard(self, agent: AgentSpec, kind: str, summary: str, preview: str, details: dict[str, Any] | None = None, *,
                    dangerous: bool = False) -> tuple[bool, str]:
        """Approval gate for one action (see PolicyGate.decide). Returns (allowed, reason-if-denied)."""
        return await self.policy.decide(agent.id, kind, summary, preview, details, dangerous=dangerous)

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
        # Characters streamed since the last persisted status refresh. Counted, never timed: agent_status is stored in the run
        # log, so a clock-based refresh would make the log depend on how fast the database answers.
        streamed_since_status = 0
        remaining = max(5.0, self.budget.timeout_s - self.active_now())

        idle: asyncio.Timeout | None = None
        t_start = time.monotonic()

        async def _consume() -> None:
            nonlocal buf, last, speaking, tool_buf, think_buf, think_last, fresh_call, streamed_since_status
            async for chunk in self.services.require("models.router").stream_with_retry(req):
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
                    streamed_since_status += len(d)
                    if streamed_since_status >= 120:
                        streamed_since_status = 0
                        status, activity = live_activity(tool_buf[:2000])
                        await self.set_agent_status(agent.id, status, activity)
                    if len(buf) >= 120 or time.monotonic() - last > 0.1:  # token_stream is live-only, so timing may decide
                        await self.emit("token_stream", {"agent_id": agent.id, "delta": buf, "turn_no": self.turn_no})
                        buf, last = "", time.monotonic()
                if chunk.tool_calls is not None:
                    result.tool_calls = list(chunk.tool_calls)
                if chunk.items is not None:
                    result.items = list(chunk.items)
                if chunk.delta:
                    parts.append(chunk.delta)
                    buf += chunk.delta
                    streamed_since_status += len(chunk.delta)
                    first = not speaking
                    speaking = True
                    if first or streamed_since_status >= 80:  # the first chunk always sets the status; later ones are counted
                        streamed_since_status = 0
                        status, activity = live_activity("".join(parts))
                        await self.set_agent_status(agent.id, status, activity)
                    if first or len(buf) >= 80 or time.monotonic() - last > 0.06:  # token_stream is live-only, so timing may decide
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

    async def execute(self, agent: AgentSpec, action: Any) -> None:
        self.execution.assert_current_attempt()
        context = ACTIVE_ATTEMPT.get()
        if context and context.assignment.owner != agent.id:
            raise ValueError("A worker cannot act for another agent")
        name = action.action
        if context and context.assignment.task_id:
            from app.sdk.task_contracts import permits_path
            owned_task = self.tasks.get(context.assignment.task_id)
            if owned_task and not self.task_ready(owned_task) and name not in (
                "send_message", "read_file", "search_project", "list_files", "recall_context", "wait"):
                self.notice(agent.id, "This task is waiting on dependencies or is blocked. Answer peers or wait; do not start its work.", activate=True)
                return
            scopes = context.assignment.write_paths
            paths = [getattr(action, field) for field in ("path", "source", "destination") if hasattr(action, field)]
            mutation = name in ("write_file", "edit_file", "create_folder", "move_file")
            if (mutation and any(not permits_path(scopes, path) for path in paths)) or (
                scopes != ("*",) and name in ("run_code", "mcp_call")):
                self.notice(agent.id, "Task write scope denied this action. Scoped tasks use brokered file tools; arbitrary terminal/MCP writes require the lead's explicit replan.", activate=True)
                await self.emit("error", {"message": "Task write scope denied action", "agent_id": agent.id, "kind": "permission"})
                return
        tool = A.ACTION_TOOL.get(name)
        if tool and (not A.tool_enabled(agent.tools, tool) or (context and tool not in context.assignment.policy.capabilities)):
            self.notice(agent.id, f"Action '{name}' is not available to you (tool '{tool}' disabled).", activate=True)
            await self.emit("error", {"message": f"{agent.name} tried disabled tool {tool}", "agent_id": agent.id, "kind": "permission"})
            return
        handler = getattr(self.execution, f"act_{name}", None)
        if handler is None:
            handler = self.kernel.tools.handler(name)
            if handler is None:
                self.notice(agent.id, f"Action '{name}' is not available: the plugin that provides it is disabled.", activate=True)
                await self.emit("error", {"message": f"{agent.name} used '{name}', whose plugin is disabled", "agent_id": agent.id, "kind": "permission"})
                return
            await handler(self, agent, action)
        else:
            await handler(agent, action)

    async def deny(self, agent: AgentSpec, cid: str, tool: str, reason: str) -> None:
        self.notice(agent.id, reason, activate=True)
        await self._tool_result(agent, cid, tool, False, reason)
        await self.emit("error", {"message": f"{agent.name}: {reason}", "agent_id": agent.id, "kind": "permission"})

    async def _tool_event(self, agent: AgentSpec, tool: str, args: dict[str, Any]) -> str:
        cid = new_id()
        await self.execution.execution_tool_start(cid, tool, args)
        await self.emit("tool_call", {"call_id": cid, "agent_id": agent.id, "tool": tool, "args": args, "turn_no": self.turn_no})
        return cid

    async def _tool_result(self, agent: AgentSpec, cid: str, tool: str, ok: bool, output: str) -> None:
        await self.execution.execution_tool_result(agent, cid, tool, ok, output)
        await self.emit("tool_result", {"call_id": cid, "agent_id": agent.id, "tool": tool, "ok": ok, "output": output[:4000]})

    # Methods of the run engine's own modules, bound as methods. Plugins add theirs through the run-method table (see __getattr__).
    # run_control
    next_runnable = run_control.next_runnable
    active_now = run_control.active_now
    limit_reason = run_control.limit_reason
    check_stall = run_control.check_stall
    gate = run_control.gate
    pause = run_control.pause
    resume = run_control.resume
    step = run_control.step
    stop = run_control.stop
    bootstrap = run_control.bootstrap
    main = run_control.main
    loop_has_active_agents = run_control.loop_has_active_agents
    loop_mark_started = run_control.loop_mark_started
    begin_run = run_control.begin_run
    loop_housekeeping = run_control.loop_housekeeping
    loop_idle_step = run_control.loop_idle_step
    loop_pick_batch = run_control.loop_pick_batch
    loop_completion_reason = run_control.loop_completion_reason
    loop_apply_queued_request = run_control.loop_apply_queued_request
    loop_after_turn = run_control.loop_after_turn

    # run_state
    state_dict = run_state.state_dict
    save = run_state.save
    restore = run_state.restore
    _load_memory = run_state._load_memory
    set_run_status = run_state.set_run_status
    set_agent_status = run_state.set_agent_status
    usage_event = run_state.usage_event
    add_usage = run_state.add_usage

    # mailbox
    deliver = mailbox.deliver
    observe = mailbox.observe
    notice = mailbox.notice
    post_message = mailbox.post_message
    announce_message = mailbox.announce_message
    requeue = mailbox.requeue

    # board
    log = board.log
    decide = board.decide
    digest = board.digest
    mark_work = board.mark_work
    start_turn_metrics = board.start_turn_metrics
    efficiency = board.efficiency
    file_lock = board.file_lock
    mark_progress = board.mark_progress
    nudge_open_tasks = board.nudge_open_tasks
    resolve_agent = board.resolve_agent
    blackboard = board.blackboard
    turn_context = board.turn_context

    # turn_loop
    effort_for = turn_loop.effort_for
    turn = turn_loop.turn
    _turn = turn_loop._turn
    model_for = turn_loop.model_for
    build_request = turn_loop.build_request
    native_tools_for = turn_loop.native_tools_for
    native_turn = turn_loop.native_turn
    _tool_loop = turn_loop._tool_loop
    run_tool_call = turn_loop.run_tool_call
    end_turn = turn_loop.end_turn

    # lifecycle
    continue_with = lifecycle.continue_with
    entry_agents = lifecycle.entry_agents
    goal_images = lifecycle.goal_images
    attach_followup = lifecycle.attach_followup
    preview_url = lifecycle.preview_url
    load_roles = lifecycle.load_roles
    finalize = lifecycle.finalize
    _finalize = lifecycle._finalize


def _forward(owner: str, name: str):  # type: ignore[no-untyped-def]
    def method(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        return getattr(getattr(self, owner), name)(*args, **kwargs)

    method.__name__ = name
    return method


for _name in FLOW_METHODS:
    setattr(RunRuntime, _name, _forward("flow", _name))
for _name in ORG_METHODS:
    setattr(RunRuntime, _name, _forward("org", _name))

async def load_run(run_id: str, project: ProjectRef) -> tuple[Run, str] | None:
    """Read a run row and its owner's user id from the project database."""

    async with project.sf() as db:
        run = await RunRepository(db).get(run_id)
        if run is None:
            return None
        company = await CompanyRepository(db).get(run.company_id)
        return run, company.user_id if company else ""


def default_budget() -> dict[str, Any]:
    s = get_settings()
    return RunBudget(max_turns=s.default_max_turns, max_tokens=s.default_max_tokens_budget, max_cost_usd=s.default_max_cost_usd,
                     timeout_s=s.default_timeout_s).model_dump()
