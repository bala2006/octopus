"""Golden artifacts: regenerate every file under tests/golden in memory and compare it byte for byte.

A failure here means behavior or a contract changed (OpenAPI, schema, tool names and schemas, prompts, approvals, sandbox
rules, protocol transcripts, or run event sequences). If the change is intended, regenerate and list it in the PR:

    cd backend && python -m scripts.golden.export_all
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.kernel.runtime.engine import RunRuntime
from scripts.golden.export_all import BACKEND, GOLDEN_DIR, generate_all

REGENERATE = "Regenerate with: cd backend && python -m scripts.golden.export_all"


def _tree(root: Path) -> dict[str, bytes]:
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


async def test_committed_golden_files_match_regeneration() -> None:
    generated = {rel: text.encode("utf-8") for rel, text in (await generate_all()).items()}
    committed = _tree(GOLDEN_DIR)
    missing = sorted(set(generated) - set(committed))
    stale = sorted(set(committed) - set(generated))
    changed = sorted(rel for rel in generated.keys() & committed.keys() if generated[rel] != committed[rel])
    assert not (missing or stale or changed), f"missing: {missing}\nstale: {stale}\nchanged: {changed}\n{REGENERATE}"


async def test_generation_is_deterministic_in_process() -> None:
    first = await generate_all()
    second = await generate_all()
    assert first.keys() == second.keys()
    differing = sorted(rel for rel in first if first[rel] != second[rel])
    assert not differing, f"two generations in one process differ: {differing}"


def test_generation_is_identical_across_processes(tmp_path: Path) -> None:
    """Set iteration order depends on the process hash seed. Two processes with different seeds must still agree."""
    trees = []
    for seed in ("0", "1"):
        out = tmp_path / f"seed-{seed}"
        env = {**os.environ, "PYTHONHASHSEED": seed}
        subprocess.run([sys.executable, "-m", "scripts.golden.export_all", "--out", str(out)], cwd=BACKEND, env=env,
                       check=True, capture_output=True, text=True, timeout=600)
        trees.append(_tree(out))
    first, second = trees
    assert first.keys() == second.keys()
    differing = sorted(rel for rel in first if first[rel] != second[rel])
    assert not differing, f"hash seed changes the output: {differing}"


async def test_slow_status_write_does_not_change_the_run_log(monkeypatch: pytest.MonkeyPatch) -> None:
    """A slow database commit for a status write must not add a streaming status to the persisted run log.

    Streaming status used to be refreshed on a timer (0.1 s). Any write slower than that put an extra agent_status event into the
    log, so the log depended on wall-clock speed. Every writing status below takes 0.15 s, so a timer-based refresh always shows up.
    """
    baseline = await generate_all()
    original = RunRuntime.set_agent_status

    async def slow_status(self: RunRuntime, aid: str, status: str, activity: str = "") -> None:
        if status == "writing":
            await asyncio.sleep(0.15)
        await original(self, aid, status, activity)

    monkeypatch.setattr(RunRuntime, "set_agent_status", slow_status)
    slowed = await generate_all()
    differing = sorted(rel for rel in baseline if baseline[rel] != slowed[rel])
    assert not differing, f"a slow status write changed the run log: {differing}"
