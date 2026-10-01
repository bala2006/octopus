"""Deterministic Run Report generation (Markdown) from persisted run data."""
from __future__ import annotations

from collections import Counter

from sqlalchemy import select

from app.db.session import SessionFactory
from app.models import Artifact, Message, Run, RunEvent, Task


def _dur(run: Run) -> str:
    if run.started_at and run.ended_at:
        s = int((run.ended_at - run.started_at).total_seconds())
        return f"{s // 60}m {s % 60}s"
    return "n/a"


async def build_report(run_id: str, sf: SessionFactory) -> str:
    async with sf() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        msgs = (await db.execute(select(Message).where(Message.run_id == run_id).order_by(Message.created_at))).scalars().all()
        tasks = (await db.execute(select(Task).where(Task.run_id == run_id).order_by(Task.key))).scalars().all()
        arts = (await db.execute(select(Artifact).where(Artifact.run_id == run_id).order_by(Artifact.path, Artifact.version))).scalars().all()
        events = (await db.execute(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.type.in_(
            ["protocol", "message_rejected", "error", "tool_result", "agent_created", "agent_updated"])).order_by(RunEvent.id))).scalars().all()

    snap = run.snapshot_json or {}
    agents = {a["id"]: a for a in snap.get("agents", [])}
    name = lambda aid: "User" if aid is None else agents.get(aid, {}).get("name", "?")  # noqa: E731
    state = run.state_json or {}
    per_agent = state.get("agent_tokens", {})

    out: list[str] = [f"# Run Report: {snap.get('company', {}).get('name', 'Company')}", ""]
    out += [f"**Goal:** {run.goal}", "",
            "| Status | Mode | Turns | Tokens | Cost | Duration |", "|---|---|---|---|---|---|",
            f"| {run.status} | {run.mode} | {run.turns} | {run.tokens_used:,} | ${run.cost_usd:.4f} | {_dur(run)} |", ""]
    if run.halt_reason:
        out += [f"> Halt reason: {run.halt_reason}", ""]
    if run.summary:
        out += ["## Outcome", "", run.summary, ""]
    m = state.get("metrics") or {}
    if m.get("turns"):
        out += ["## Efficiency", "",
                f"- Turns that changed a deliverable or ran something: {m.get('work_turns', 0)} of {m['turns']} "
                f"({round(100 * (1 - m.get('overhead_share', 0)))}%); the rest was coordination",
                f"- First deliverable file at turn: {m.get('first_deliverable_turn') or 'none'}",
                f"- Delegations: {m.get('delegations', 0)} ({m.get('parallel_delegations', 0)} run in parallel)", ""]

    wf = state.get("workflow") or {}
    if wf.get("phases"):
        from app.orchestrator.workflow import PHASES

        out += [f"## Workflow ({wf.get('track') or 'intake only'} track)", "", "| Phase | Owner | Status | Fix rounds | Summary |", "|---|---|---|---|---|"]
        for p in wf["phases"]:
            title = PHASES[p["key"]].title if p["key"] in PHASES else p["key"]
            summary = (p.get("summary") or "").replace("\n", " ").replace("|", "/")[:160]
            out.append(f"| {title} | {name(p.get('owner')) if p.get('owner') else '-'} | {p.get('status')} | {p.get('loops') or ''} | {summary} |")
        out.append("")

    out += ["## Team", "", "| Agent | Role | Department | Model | Turns | Tokens |", "|---|---|---|---|---|---|"]
    turns = state.get("agent_turns", {})
    for aid, a in agents.items():
        tags = (" (entry)" if a.get("is_entry") else "") + (" · manager" if a.get("is_manager") else "") + \
               (f" · hired by {name(a['created_by'])}" if a.get("created_by") else "") + ("" if a.get("active", True) else " · inactive")
        out.append(f"| {a['name']}{tags} | {a.get('role', '')} | {a.get('department') or '-'} | {a.get('provider')}/{a.get('model')} | "
                   f"{turns.get(aid, 0)} | {per_agent.get(aid, 0):,} |")
    out.append("")
    org = [e for e in events if e.type in ("agent_created", "agent_updated")]
    if org:
        out += ["## Org changes", ""]
        for e in org:
            p = e.payload_json
            if e.type == "agent_created":
                a = p["agent"]
                out.append(f"- **{name(p['created_by'])}** hired **{a['name']}** ({a['role']}, {a.get('department') or 'no department'})"
                           + ("" if p.get("persisted") else " (run only)"))
            else:
                who = "its own configuration" if p.get("self") else f"{p.get('old_name')}'s configuration"
                out.append(f"- **{name(p['by'])}** updated {who}: {p.get('summary')}" + (f" (reason: {p['reason']})" if p.get("reason") else ""))
        out.append("")

    decisions = state.get("decisions", [])
    out += ["## Key decisions", ""] + ([f"- {d}" for d in decisions] or ["- None recorded"]) + [""]

    debates = state.get("debates", {})
    out += ["## Debates", ""]
    if debates:
        for d in debates.values():
            parts = " ↔ ".join(name(p) for p in d["participants"])
            out.append(f"- **{parts}**: {d['status']} after {d.get('rounds', 0)} round(s) (max {d['max_rounds']}). Topic: {d.get('topic', '')}")
            if d.get("outcome"):
                out.append(f"  - Outcome: {d['outcome'][:300]}")
            for h in d.get("history", []):
                out.append(f"  - {name(h['from'])} *{h['type']}*: {h['content'][:160]}")
    else:
        out.append("- No debates")
    out.append("")

    reviews = state.get("reviews", {})
    out += ["## Reviews", ""]
    if reviews:
        for r in reviews.values():
            out.append(f"- **{name(r['author'])} → {name(r['reviewer'])}**: {r['status']} ({r['revisions']} revision(s), max {r['max_revisions']})")
            for h in r.get("history", []):
                if h.get("event") == "review_result":
                    out.append(f"  - {h['verdict']}" + "".join(f"\n    - {c}" for c in h.get("comments", [])))
    else:
        out.append("- No reviews")
    out.append("")

    out += ["## Task board (final)", "", "| Key | Title | Assignee | Status |", "|---|---|---|---|"]
    out += [f"| {t.key} | {t.title} | {name(t.assignee_agent_id) if t.assignee_agent_id else '-'} | {t.status} |" for t in tasks] or ["| - | - | - | - |"]
    out.append("")

    latest: dict[str, Artifact] = {}
    for a in arts:
        latest[a.path] = a
    out += ["## Artifacts", "", f"Permission level: **{run.permission_level}**", "",
            "| Path | Versions | Last author | Kind | Note |", "|---|---|---|---|---|"]
    vcount = Counter(a.path for a in arts)
    first = {a.path: a for a in reversed(arts)}
    kind = lambda p, a: "planned" if a.planned else ("modified" if first[p].previous_content is not None else "created")  # noqa: E731
    out += [f"| `{p}` | {vcount[p]} | {name(a.author_agent_id)} | {kind(p, a)} | {a.change_note[:80]} |" for p, a in sorted(latest.items())] or ["| - | - | - | - | - |"]
    out.append("")

    tests = [e for e in events if e.type == "tool_result" and e.payload_json.get("tool") == "run_code"]
    if tests:
        last = tests[-1].payload_json
        out += ["## Test / execution results", "", f"Last execution: {'✅ passed' if last.get('ok') else '❌ failed'}", "",
                "```", last.get("output", "")[-1500:], "```", ""]

    rejected = [e for e in events if e.type == "message_rejected"]
    errors = [e for e in events if e.type == "error"]
    out += ["## Guardrails", "", f"- Messages rejected by channel/protocol rules: {len(rejected)}",
            f"- Errors / limit events: {len(errors)}"]
    for e in (rejected + errors)[:10]:
        p = e.payload_json
        out.append(f"  - {p.get('reason') or p.get('message')}")
    out.append("")

    out += ["## Timeline", ""]
    types = Counter(m.type for m in msgs)
    out.append("Message mix: " + ", ".join(f"{k} ×{v}" for k, v in types.most_common()))
    out.append("")
    for m in msgs:
        if m.type == "artifact_created":
            continue
        first = m.content.strip().splitlines()[0][:140] if m.content.strip() else ""
        out.append(f"{m.turn_no:>3}. **{name(m.from_agent_id)} → {name(m.to_agent_id) if m.to_agent_id else 'User'}** `{m.type}`: {first}")
    out.append("")
    return "\n".join(out)
