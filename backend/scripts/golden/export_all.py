"""Write every golden artifact under backend/tests/golden/. Run from backend/:

    python -m scripts.golden.export_all
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from scripts.golden.approvals_export import approval_json
from scripts.golden.db_schema import project_sql, registry_sql
from scripts.golden.openapi_export import openapi_json
from scripts.golden.prompts_export import prompt_texts
from scripts.golden.protocols_export import debate_json, review_json
from scripts.golden.runs_export import run_texts
from scripts.golden.sandbox_export import sandbox_json
from scripts.golden.tools_export import tools_json

BACKEND = Path(__file__).resolve().parents[2]
GOLDEN_DIR = BACKEND / "tests" / "golden"
# Subdirectories this exporter owns: files in them that it no longer generates are removed.
OWNED_DIRS = ("db", "prompts", "protocols", "runs")


async def generate_all() -> dict[str, str]:
    """Relative path under tests/golden -> exact file text, for every artifact. Nothing is written to disk."""
    files: dict[str, str] = {
        "openapi.json": openapi_json(),
        "db/registry.sql": registry_sql(),
        "db/project.sql": project_sql(),
        "tools.json": tools_json(),
        "sandbox_cases.json": sandbox_json(),
        "approval_cases.json": await approval_json(),
        "protocols/debate.json": debate_json(),
        "protocols/review.json": review_json(),
    }
    for role, text in (await prompt_texts()).items():
        files[f"prompts/{role}.txt"] = text
    files.update(await run_texts())
    return dict(sorted(files.items()))


def write_all(files: dict[str, str], target: Path = GOLDEN_DIR) -> None:
    for rel, text in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    for sub in OWNED_DIRS:
        for path in (target / sub).rglob("*"):
            if path.is_file() and path.relative_to(target).as_posix() not in files:
                path.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the golden artifacts (run from backend/).")
    parser.add_argument("--out", type=Path, default=GOLDEN_DIR, help="directory to write (default: backend/tests/golden)")
    args = parser.parse_args(argv)
    files = asyncio.run(generate_all())
    write_all(files, args.out)
    print(f"wrote {len(files)} golden files to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
