"""Team knowledge: the engine journal, task-board awareness and nudges, metrics, and the blackboard each prompt carries."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from app.sdk.text import clip
from app.sdk.agents import AgentSpec
from app.sdk.routing import allowed_recipients
from app.kernel.runtime.run_state import JOURNAL_MAX

if TYPE_CHECKING:  # pragma: no cover
    from app.kernel.runtime.engine import RunRuntime


DIGEST_LINES = 40


def log(rt: RunRuntime, aid: str | None, text: str) -> None:
    """Record something the whole team should know about (shown to each agent once, in its next prompt)."""
    rt.journal_n += 1
    rt.journal.append({"n": rt.journal_n, "turn": rt.turn_no, "agent": aid, "text": text[:500]})
    del rt.journal[:-JOURNAL_MAX]


def decide(rt: RunRuntime, text: str, aid: str | None = None) -> None:
    rt.decisions.append(text)
    rt.log(aid, text)


def digest(rt: RunRuntime, aid: str) -> str:
    """What teammates did since this agent's last turn: the engine's log plus one line per message between others."""
    since = rt.seen.get(aid, 0)
    rows: list[tuple[int, str]] = [(e["turn"], f"- t{e['turn']} {rt.names.get(e['agent'] or '', 'Octopus')}: {e['text']}")
                                   for e in rt.journal if e["n"] > since and e["agent"] != aid]
    rows.sort(key=lambda r: r[0])
    lines = [r[1] for r in rows]
    if len(lines) > DIGEST_LINES:
        lines = [f"- … {len(lines) - DIGEST_LINES} earlier entries (see the Blackboard and files)"] + lines[-DIGEST_LINES:]
    return "\n".join(lines)


def mark_work(rt: RunRuntime, aid: str) -> None:
    """This turn changed a deliverable or ran something (as opposed to only coordinating)."""
    if not rt.turn_work.get(aid):
        rt.turn_work[aid] = True
        rt.metrics["work_turns"] += 1


def start_turn_metrics(rt: RunRuntime, aid: str) -> None:
    rt.metrics["turns"] += 1
    rt.turn_work[aid] = False


def efficiency(rt: RunRuntime) -> dict[str, Any]:
    turns = rt.metrics["turns"]
    return {"turns": turns, "work_turns": rt.metrics["work_turns"],
            "overhead_share": round(1 - rt.metrics["work_turns"] / turns, 3) if turns else 0.0,
            "first_deliverable_turn": rt.first_deliverable_turn, "delegations": rt.metrics["delegations"],
            "parallel_delegations": rt.metrics["parallel_delegations"]}


def file_lock(rt: RunRuntime, rel: str) -> asyncio.Lock:
    return rt._file_locks.setdefault(rel, asyncio.Lock())


def mark_progress(rt: RunRuntime) -> None:
    """Something moved the run forward (a file changed, a task changed status, a verdict, a finish, user input)."""
    rt.progress_turn = rt.turn_no


async def nudge_open_tasks(rt: RunRuntime) -> bool:
    """Nobody has a queued message but the board still has open tasks: wake whoever can move them.

        Owners of actionable tasks are woken; tasks that are blocked, unassigned or owned by an inactive agent go to the
        entry agent (when *every* open task is blocked the board is deadlocked and the entry agent must resolve it). Each
        task is nudged at most once until the run makes progress again, so a stuck board ends instead of spinning."""
    open_ = rt.open_tasks()
    if not open_:
        return False
    deadlocked = not any(rt.task_ready(t) for t in open_)
    entry = (rt.entry_agents() or [None])[0]
    targets: dict[str, list[dict[str, Any]]] = {}
    for t in open_:
        if rt.nudged.get(t["key"]) == rt.progress_turn:
            continue
        owner = t["assignee"]
        if not rt.task_ready(t) and not deadlocked:
            continue
        if deadlocked or owner not in rt.agents or not rt.agents[owner].active:
            owner = entry
        if owner is None:
            continue
        rt.nudged[t["key"]] = rt.progress_turn
        targets.setdefault(owner, []).append(t)
    for aid, ts in targets.items():
        lines = "\n".join(f"- {rt.task_line(t)}" for t in ts)
        if deadlocked:
            body = (f"Every open task on the board is blocked, so nobody can move:\n{lines}\n\nResolve the blocker (do the missing "
                    "work yourself or assign it to someone who can), re-plan the tasks, or ask the user. Update the task board.")
        else:
            body = (f"These tasks are still open and nobody is working on them:\n{lines}\n\nContinue them now, or update the task "
                    "board (done / blocked with the reason) and tell whoever is waiting on you.")
        await rt.post_message(sender="system", from_id=None, to_id=aid, type_="task", content="[Octopus scheduler] " + body,
                                meta={"nudge": True, "tasks": [t["key"] for t in ts]})
    if targets:
        await rt.emit("error", {"kind": "warning", "message": ("Task board deadlock: every open task is blocked; asked "
                                                                 if deadlocked else "Run went idle with open tasks; woke ")
                                  + ", ".join(rt.names.get(a, a) for a in targets)})
    return bool(targets)


def resolve_agent(rt: RunRuntime, name: str) -> str | None:
    n = name.strip().lower().lstrip("@")
    for aid, a in rt.agents.items():
        if a.name.lower() == n or aid == name:
            return aid
    for aid, a in rt.agents.items():
        if a.role.lower() == n:
            return aid
    for aid, a in rt.agents.items():
        if a.name.lower().startswith(n) or n.startswith(a.name.lower()):
            return aid
    return None


def blackboard(rt: RunRuntime) -> str:
    lines = [f"Goal: {clip(rt.goal, 6000)}"]
    if rt.followups:
        older = len(rt.followups) - 5
        lines.append("Follow-up requests from the user (newest last; the earlier work is done, build on it, don't start over):\n"
                     + (f"- ({older} earlier follow-up(s) not shown)\n" if older > 0 else "")
                     + "\n".join(f"- {clip(f, 2000)}" for f in rt.followups[-5:]))
    if rt.decisions:
        older = len(rt.decisions) - 20
        lines.append("Decisions:\n" + (f"- ({older} earlier decision(s) not shown)\n" if older > 0 else "")
                     + "\n".join(f"- {d}" for d in rt.decisions[-20:]))
    if rt.debates:
        lines.append("Debates:\n" + "\n".join(
            f"- {' ↔ '.join(rt.names.get(p, p) for p in d.participants)}: {d.status} (round {d.rounds}/{d.max_rounds}) {d.topic}"
            for d in rt.debates.values()))
    if rt.reviews:
        lines.append("Reviews:\n" + "\n".join(
            f"- {rt.names.get(r.author, '?')} → {rt.names.get(r.reviewer, '?')}: {r.status} (revisions {r.revisions}/{r.max_revisions})"
            for r in rt.reviews.values()))
    if rt.tasks:
        lines.append("Task board:\n" + "\n".join(
            f"- {t['key']} [{t['status']}] {t['title']} (assignee: {rt.names.get(t['assignee'] or '', 'unassigned')})"
            for t in rt.tasks.values()))
    if rt.artifacts:
        lines.append("Workspace files:\n" + "\n".join(
            f"- {p} v{a['version']} by {rt.names.get(a['author'] or '', '?')}" for p, a in sorted(rt.artifacts.items())))
    if rt.wf:
        lines.append(rt.wf_blackboard())
    if rt.engineering_checkpoints:
        lines.append("Engineering checkpoints (current task revision):\n" + "\n".join(
            f"- {r['step']} [{r['status']}] owner {rt.names.get(r['owner'], r['owner'])}: "
            + clip(json.dumps(r['outputs'], ensure_ascii=False), 800)
            for r in rt.engineering_checkpoints[-12:] if r["revision"] == rt.plan_revision))
    if rt.broken_files:
        lines.append("Files FAILING automatic checks (fix before anything else):\n" + "\n".join(
            f"- {p}: {msg.splitlines()[0][:300]}" for p, msg in sorted(rt.broken_files.items())))
    if rt.user_notes:
        older = len(rt.user_notes) - 10
        lines.append("User notes:\n" + (f"- ({older} earlier note(s) not shown)\n" if older > 0 else "")
                     + "\n".join(f"- {n}" for n in rt.user_notes[-10:]))
    idle = rt.turn_no - rt.progress_turn
    lines.append(f"Progress: last file / task-board change at turn {rt.progress_turn}"
                 + (f" ({idle} turns ago: deliver something or update the board instead of more discussion)" if idle >= 5 else ""))
    lines.append(f"Budget: turn {rt.turn_no}/{rt.budget.max_turns}, tokens {rt.tokens}/{rt.budget.max_tokens}")
    return "\n".join(lines)


def turn_context(rt: RunRuntime, agent: AgentSpec, inbox: list[dict[str, Any]], obs: list[dict[str, Any]]) -> dict[str, Any]:
    allowed = allowed_recipients(rt.edges, agent.id)
    cat = lambda aid: rt.agents[aid].category if aid in rt.agents else "user"  # noqa: E731
    return {
        "agent": {"id": agent.id, "name": agent.name, "role": agent.role, "category": agent.category, "is_entry": agent.is_entry,
                  "department": agent.department, "is_manager": agent.is_manager, "tools": agent.tools,
                  "manager": rt.names.get(agent.reports_to or ""),
                  "reports": [x.name for x in rt.agents.values() if x.reports_to == agent.id and x.active]},
        "goal": rt.goal,
        "inbox": [{"from": "user" if m["from"] is None else rt.names.get(m["from"], "?"),
                   "from_category": "user" if m["from"] is None else cat(m["from"]),
                   "type": m["type"], "content": m["content"], "verdict": m["meta"].get("verdict"),
                   "comments": m["meta"].get("comments", [])} for m in inbox],
        "observations": obs,
        "allowed": [{"name": rt.names[r], "role": rt.agents[r].role, "category": rt.agents[r].category,
                     "edge_types": [e.type for e in es]} for r, es in allowed.items()],
        "roster": [{"name": a.name, "role": a.role, "category": a.category, "department": a.department, "is_manager": a.is_manager,
                    "active": a.active, "status": rt.status.get(a.id, "idle"), "manager": rt.names.get(a.reports_to or "")}
                   for a in rt.agents.values()],
        "tasks": [{"key": t["key"], "title": t["title"], "assignee": rt.names.get(t["assignee"] or "", None), "status": t["status"]}
                  for t in rt.tasks.values()],
        "state": rt.agent_state.setdefault(agent.id, {}),
    }
