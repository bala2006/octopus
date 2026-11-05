"""Approval gate decisions, taken from the real RunRuntime.guard (and _team_guard for hiring and self-edits).

The methods run unchanged on a stub object that carries only the attributes they read. ``request_approval`` is replaced on the
stub: it records each call and returns a fixed decision, so no approval card, event or database write happens.
"""
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from app.orchestrator.context import AgentSpec
from app.orchestrator.engine import RunRuntime
from scripts.golden.canon import dump_json

LEVELS = ("ask", "auto")
RUN_MODES = ("autonomous", "step", "supervised")
DANGEROUS = (False, True)
DECISIONS = {"approved": (True, ""), "rejected": (False, "golden rejection")}

AGENT = AgentSpec.from_dict({"id": "golden-agent", "name": "Golden Agent", "role": "Engineer"}, "generic")

# Fixed inputs per guard kind, shaped like the call sites in engine.py. ``finish`` is only gated by guard in supervised runs.
GUARD_INPUTS: dict[str, tuple[str, str, dict[str, Any]]] = {
    "write_file": ("Golden Agent wants to modify src/app.py", "print('hi')\n",
                   {"path": "src/app.py", "old": "print('bye')\n", "new": "print('hi')\n", "note": "greeting"}),
    "run_code": ("Golden Agent wants to run `python -m pytest -q`", "python -m pytest -q",
                 {"command": "python -m pytest -q", "cwd": ".", "outside": []}),
    "mcp_call": ("Golden Agent wants to call browser/browser_navigate", "{'url': 'http://127.0.0.1/'}",
                 {"server": "browser", "tool": "browser_navigate", "arguments": {"url": "http://127.0.0.1/"}}),
    "web_search": ("Golden Agent wants to search the web", "release notes",
                   {"query": "release notes"}),
    "finish": ("Golden Agent wants to finish", "All done.", {"summary": "All done."}),
}

TEAM_INPUTS: dict[str, tuple[str, dict[str, Any]]] = {
    "create_agent": ("Golden Agent wants to hire Rae (Engineer, Engineering)", {"name": "Rae", "role": "Engineer", "department": "Engineering"}),
    "update_agent": ("Golden Agent wants to update its own configuration", {"target": "Golden Agent", "changes": {"role": "Lead"}, "reason": "focus"}),
}


def _record(calls: list[dict[str, Any]], decision: tuple[bool, str]):  # type: ignore[no-untyped-def]
    async def request_approval(agent: AgentSpec, kind: str, summary: str, preview: str, details: dict[str, Any] | None = None):  # type: ignore[no-untyped-def]
        calls.append({"agent": agent.id, "kind": kind, "summary": summary, "preview": preview, "details": details})
        return decision

    return request_approval


async def guard_records() -> list[dict[str, Any]]:
    records = []
    for level in LEVELS:
        for mode in RUN_MODES:
            for kind in sorted(GUARD_INPUTS):
                for dangerous in DANGEROUS:
                    for outcome, decision in DECISIONS.items():
                        calls: list[dict[str, Any]] = []
                        stub = SimpleNamespace(level=level, mode=mode, request_approval=_record(calls, decision))
                        summary, preview, details = GUARD_INPUTS[kind]
                        allowed, reason = await RunRuntime.guard(stub, AGENT, kind, summary, preview, details, dangerous=dangerous)
                        records.append({"level": level, "run_mode": mode, "kind": kind, "dangerous": dangerous, "user_decision": outcome,
                                        "asked": bool(calls), "request": calls[0] if calls else None,
                                        "allowed": allowed, "reason": reason})
    return records


async def team_guard_records() -> list[dict[str, Any]]:
    records = []
    for level in LEVELS:
        for persist in (True, False):
            for kind in sorted(TEAM_INPUTS):
                for outcome, decision in DECISIONS.items():
                    calls: list[dict[str, Any]] = []
                    stub = SimpleNamespace(level=level, budget=SimpleNamespace(persist_team=persist), request_approval=_record(calls, decision))
                    summary, details = TEAM_INPUTS[kind]
                    allowed, persisted, reason = await RunRuntime._team_guard(stub, AGENT, kind, summary, details)
                    records.append({"level": level, "persist_team": persist, "kind": kind, "user_decision": outcome,
                                    "asked": bool(calls), "request": calls[0] if calls else None,
                                    "allowed": allowed, "persist": persisted, "reason": reason})
    return records


async def approval_records() -> dict[str, Any]:
    return {"guard": await guard_records(), "team_guard": await team_guard_records()}


async def approval_json() -> str:
    return dump_json(await approval_records())
