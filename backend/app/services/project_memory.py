"""Project memory: knowledge that outlives a run, shared by every agent in the project.

Stored in ``<project>/.octopus/memory.json``:

* ``notes``: what agents chose to remember for the whole project (``remember`` with ``scope: "project"``), e.g. conventions,
  where things live, decisions that should stick.
* ``runs``: a short automatic retrospective of each finished run (goal, outcome, files produced, open tasks, decisions,
  efficiency), so the next run starts from what earlier runs did instead of from zero.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.core.config import PROJECT_DIRNAME
from app.db.base import utcnow

MAX_NOTES = 200
MAX_RUNS = 20
SHOW_RUNS = 3


def _path(root: Path) -> Path:
    return root / PROJECT_DIRNAME / "memory.json"


def load(root: Path) -> dict[str, Any]:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"notes": dict(data.get("notes") or {}), "runs": list(data.get("runs") or [])}


def _save(root: Path, data: dict[str, Any]) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def remember(root: Path, key: str, value: str, by: str) -> dict[str, Any]:
    data = load(root)
    if value.strip():
        data["notes"][key] = {"value": value, "by": by, "at": utcnow().isoformat(timespec="seconds")}
    else:
        data["notes"].pop(key, None)  # an empty value forgets the note
    if len(data["notes"]) > MAX_NOTES:  # keep the newest
        data["notes"] = dict(sorted(data["notes"].items(), key=lambda kv: kv[1].get("at", ""))[-MAX_NOTES:])
    _save(root, data)
    return data


def add_run(root: Path, retro: dict[str, Any]) -> dict[str, Any]:
    data = load(root)
    data["runs"] = [r for r in data["runs"] if r.get("run_id") != retro.get("run_id")] + [retro]
    data["runs"] = data["runs"][-MAX_RUNS:]
    _save(root, data)
    return data


def render(data: dict[str, Any], *, exclude_run: str | None = None) -> str:
    """Prompt section (empty when there's nothing yet)."""
    lines: list[str] = []
    notes = data.get("notes") or {}
    if notes:
        lines.append("Notes:")
        lines += [f"- {k}: {v.get('value', '')[:1500]}" + (f" (by {v['by']})" if v.get("by") else "") for k, v in notes.items()]
    runs = [r for r in data.get("runs") or [] if r.get("run_id") != exclude_run][-SHOW_RUNS:]
    if runs:
        lines.append("Earlier runs (newest last):")
        for r in runs:
            lines.append(f"- {r.get('at', '')[:10]} \"{r.get('goal', '')[:200]}\": {r.get('status')}"
                         + (f" ({r['halt_reason'][:160]})" if r.get("halt_reason") else ""))
            if r.get("summary"):
                lines.append(f"  Result: {r['summary'][:400]}")
            if r.get("files"):
                lines.append(f"  Files: {', '.join(r['files'][:25])}")
            if r.get("open_tasks"):
                lines.append(f"  Left open: {'; '.join(r['open_tasks'][:8])}")
            if r.get("decisions"):
                lines.append(f"  Decisions: {'; '.join(d[:160] for d in r['decisions'][:5])}")
    return "\n".join(lines)
