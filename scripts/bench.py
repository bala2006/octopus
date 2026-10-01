#!/usr/bin/env python3
"""Benchmark company templates on the same coding tasks against a running Octopus backend.

    backend/.venv/bin/python scripts/bench.py --projects-root ~/octopus-bench \\
        --templates solo_engineer,engineer_reviewer,software_startup

    # compare the context approaches on the same tasks (pointers = archive + recall + ledger; summary = the previous one)
    backend/.venv/bin/python scripts/bench.py --projects-root ~/octopus-bench --templates software_startup \\
        --context-modes pointers,summary --repeat 3

Each (template, task) case gets a fresh folder under --projects-root (it must be a folder the backend may open: inside
WORKSPACE_ALLOWED_ROOTS, or inside the shared laptop folder in Docker). Results: a Markdown table on stdout and a JSON file.
--demo uses the offline mock (checks the harness, not the model).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import httpx  # noqa: E402

from app.services.bench import run_case, summarize  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--projects-root", required=True, type=Path)
    ap.add_argument("--templates", default="solo_engineer,engineer_reviewer,software_startup")
    ap.add_argument("--tasks", default=str(ROOT / "bench" / "tasks.json"), type=Path)
    ap.add_argument("--only", default="", help="comma-separated task ids")
    ap.add_argument("--repeat", type=int, default=1, help="runs per case (models are not deterministic)")
    ap.add_argument("--max-turns", type=int, default=80)
    ap.add_argument("--demo", action="store_true", help="offline mock model")
    ap.add_argument("--context-modes", default="pointers", help="comma-separated: pointers, summary")
    ap.add_argument("--out", type=Path, default=Path("bench-results.json"))
    args = ap.parse_args()

    tasks = json.loads(args.tasks.read_text())
    if args.only:
        keep = set(args.only.split(","))
        tasks = [t for t in tasks if t["id"] in keep]
    modes = [m.strip() for m in args.context_modes.split(",") if m.strip()]
    if bad := [m for m in modes if m not in ("pointers", "summary")]:
        ap.error(f"unknown context mode(s): {', '.join(bad)}")
    results = []
    async with httpx.AsyncClient(base_url=args.url, timeout=60) as client:
        for tpl in args.templates.split(","):
            for mode in modes:
                budget = {"max_turns": args.max_turns, "force_mock": args.demo, "context_mode": mode}
                for task in tasks:
                    for i in range(args.repeat):
                        folder = args.projects_root.expanduser() / f"{task['id']}-{tpl}-{mode}-{uuid.uuid4().hex[:6]}"
                        print(f"… {tpl} / {mode} / {task['id']} ({i + 1}/{args.repeat})", file=sys.stderr)
                        results.append(await run_case(client, folder=folder, template=tpl, task=task, budget=budget))
    args.out.write_text(json.dumps(results, indent=1))
    print(summarize(results))
    print(f"\nDetails: {args.out}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
