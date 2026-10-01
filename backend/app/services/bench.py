"""A small benchmark: run the same coding tasks with different company templates and compare outcomes.

Each task has a goal, optional seed files and objective checks (files exist / contain text / a command succeeds). A case
creates a fresh project folder, opens it as a workspace, creates the company from a template, runs it, then checks the
folder. Results include pass/fail plus the run's efficiency (turns, share of turns spent coordinating, turn of the first
deliverable), tokens, cost and time, so "team vs. solo" can be decided with numbers. Context metrics (input tokens, the
share served from the prompt cache, messages blocked as repeats, recalls / history searches) compare context modes
("pointers" vs. the earlier "summary" approach). Driven by ``scripts/bench.py``.
"""
from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx

TERMINAL = {"completed", "incomplete", "failed", "cancelled"}


def setup_project(folder: Path, task: dict[str, Any]) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for rel, content in (task.get("files") or {}).items():
        p = folder / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")


def evaluate(folder: Path, checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for c in checks:
        kind, ok, detail = c["type"], False, ""
        if kind == "file_exists":
            ok = (folder / c["path"]).is_file()
        elif kind == "file_contains":
            p = folder / c["path"]
            texts = c["text"] if isinstance(c["text"], list) else [c["text"]]
            ok = p.is_file() and all(t in p.read_text(encoding="utf-8", errors="replace") for t in texts)
        elif kind == "command":
            cmd = [sys.executable if a == "python" else a for a in shlex.split(c["cmd"])]
            try:
                r = subprocess.run(cmd, cwd=folder, capture_output=True, text=True, timeout=c.get("timeout", 60),
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
                ok = r.returncode == 0 and all(t in r.stdout for t in c.get("stdout_contains", []))
                detail = (r.stdout + r.stderr)[-400:]
            except (OSError, subprocess.TimeoutExpired) as exc:
                detail = str(exc)
        out.append({"check": c, "ok": ok, "detail": detail})
    return out


async def run_case(client: httpx.AsyncClient, *, folder: Path, template: str, task: dict[str, Any], budget: dict[str, Any] | None = None,
                   permission: str = "danger", timeout_s: float = 1800, path_for_api: str | None = None) -> dict[str, Any]:
    """Run one task with one template. ``path_for_api``: the folder as the backend should see it (e.g. a laptop path in Docker)."""
    setup_project(folder, task)
    t0 = time.monotonic()
    r = await client.post("/api/v1/workspaces", json={"path": path_for_api or str(folder), "default_permission": permission})
    r.raise_for_status()
    w = r.json()["id"]
    r = await client.post(f"/api/v1/w/{w}/companies/from-template", json={"template_key": template})
    r.raise_for_status()
    company = r.json()["company"]["id"]
    r = await client.post(f"/api/v1/w/{w}/runs", json={"company_id": company, "goal": task["goal"], "permission_level": permission,
                                                       "budget": budget or {}})
    r.raise_for_status()
    run_id = r.json()["id"]
    run: dict[str, Any] = {}
    while time.monotonic() - t0 < timeout_s:
        run = (await client.get(f"/api/v1/w/{w}/runs/{run_id}")).json()
        if run["status"] in TERMINAL:
            break
        if run["status"] in ("paused", "awaiting_user"):  # a benchmark has nobody to answer: stop it
            await client.post(f"/api/v1/w/{w}/runs/{run_id}/control/stop")
        await asyncio.sleep(0.5)
    outcome = next((x.get("outcome") or {} for x in (await client.get(f"/api/v1/w/{w}/runs", params={"company_id": company})).json()
                    if x["id"] == run_id), {})
    checks = evaluate(folder, task.get("checks") or [])
    turns = outcome.get("agent_turns") or run.get("turns", 0)
    inp, cached = int(outcome.get("input_tokens", 0) or 0), int(outcome.get("cached_tokens", 0) or 0)
    return {"task": task["id"], "template": template, "status": run.get("status"), "passed": bool(checks) and all(c["ok"] for c in checks),
            "checks_passed": sum(c["ok"] for c in checks), "checks": len(checks), "turns": turns, "work_turns": outcome.get("work_turns", 0),
            "overhead_share": round(1 - outcome.get("work_turns", 0) / turns, 3) if turns else None,
            "first_deliverable_turn": outcome.get("first_deliverable_turn"), "delegations": outcome.get("delegations", 0),
            "tokens": run.get("tokens_used", 0), "cost_usd": run.get("cost_usd", 0.0), "seconds": round(time.monotonic() - t0, 1),
            "context_mode": outcome.get("context_mode") or (budget or {}).get("context_mode") or "pointers",
            "input_tokens": inp, "cached_tokens": cached, "cached_share": round(cached / inp, 3) if inp else None,
            "loop_strikes": int(outcome.get("loop_strikes", 0) or 0), "rejected_messages": int(outcome.get("rejected_messages", 0) or 0),
            "recalls": int(outcome.get("recalls", 0) or 0), "history_searches": int(outcome.get("history_searches", 0) or 0),
            "run_id": run_id, "halt_reason": run.get("halt_reason", ""), "check_results": checks}


def _pct(x: float | None) -> str:
    return f"{round(100 * x)}%" if x is not None else "-"


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def summarize(results: list[dict[str, Any]]) -> str:
    """Per-case table, then one row per (template, context mode): pass rate, turns, tokens, cache share, repeats."""
    lines = ["| Template | Mode | Task | Pass | Checks | Status | Turns | Overhead | 1st file at turn | Tokens | Input | Cached | "
             "Repeats blocked | Recalls | Cost | Time |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        mode = r.get("context_mode", "pointers")
        lines.append(f"| {r['template']} | {mode} | {r['task']} | {'✅' if r['passed'] else '❌'} | {r['checks_passed']}/{r['checks']} | "
                     f"{r['status']} | {r['turns']} | {_pct(r['overhead_share'])} | {r['first_deliverable_turn'] or '-'} | "
                     f"{r['tokens']:,} | {r.get('input_tokens', 0):,} | {_pct(r.get('cached_share'))} | {r.get('loop_strikes', 0)} | "
                     f"{r.get('recalls', 0) + r.get('history_searches', 0)} | ${r['cost_usd']:.4f} | {r['seconds']}s |")
    lines += ["", "| Template | Mode | Pass rate | Mean turns | Mean overhead | Mean tokens | Mean input tokens | Cached share | "
              "Repeats blocked | Rejected messages |", "|---|---|---|---|---|---|---|---|---|---|"]
    groups = dict.fromkeys((r["template"], r.get("context_mode", "pointers")) for r in results)
    for tpl, mode in groups:
        rs = [r for r in results if r["template"] == tpl and r.get("context_mode", "pointers") == mode]
        ohs = [r["overhead_share"] for r in rs if r["overhead_share"] is not None]
        inp = sum(r.get("input_tokens", 0) for r in rs)
        cached = sum(r.get("cached_tokens", 0) for r in rs)
        lines.append(f"| {tpl} | {mode} | {sum(r['passed'] for r in rs)}/{len(rs)} | {_mean([r['turns'] for r in rs]):.1f} | "
                     f"{100 * _mean(ohs):.0f}% | {_mean([r['tokens'] for r in rs]):,.0f} | {_mean([r.get('input_tokens', 0) for r in rs]):,.0f} | "
                     f"{_pct(cached / inp if inp else None)} | {_mean([r.get('loop_strikes', 0) for r in rs]):.1f} | "
                     f"{_mean([r.get('rejected_messages', 0) for r in rs]):.1f} |")
    return "\n".join(lines)
