"""Golden artifacts: regenerate every file under tests/golden in memory and compare it byte for byte.

A failure here means behavior or a contract changed (OpenAPI, schema, tool names and schemas, prompts, approvals, sandbox
rules, protocol transcripts, or run event sequences). If the change is intended, regenerate and list it in the PR:

    cd backend && python -m scripts.golden.export_all
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

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
