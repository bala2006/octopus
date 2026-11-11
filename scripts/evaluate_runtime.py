#!/usr/bin/env python3
"""Run offline runtime reliability fixtures. This is not a model quality benchmark."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
SUITES = {
    "workflow_matrix": ["tests/test_engineering_workflows.py"],
    "coordination": ["tests/test_runtime_contracts.py", "tests/test_runtime_store.py", "tests/test_scoped_memory.py",
                     "tests/test_runtime_integration.py", "tests/test_runtime_delivery.py", "tests/test_legacy_memory.py",
                     "tests/test_runtime_recovery_regressions.py", "tests/test_task_contracts.py", "tests/test_runtime_ui_evidence.py"],
    "artifacts_and_skills": ["tests/test_skill_contracts.py", "tests/test_revision_evidence.py", "tests/test_attempt_workspaces.py"],
    "acp_transport_and_workers": ["tests/test_acp_transport.py", "tests/test_worker_bridge.py", "tests/test_opencode_worker.py", "tests/test_opencode.py"],
    "diagnostic_scripts": ["tests/test_runtime_doctor.py"],
}


def junit_counts(path: Path) -> dict:
    counts = {key: 0 for key in ("tests", "failures", "errors", "skipped")}
    if not path.is_file():
        return {**counts, "passed": 0}
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    for suite in suites:
        for key in counts:
            counts[key] += int(suite.get(key, "0"))
    return {**counts, "passed": counts["tests"] - counts["failures"] - counts["errors"] - counts["skipped"]}


def source_hashes() -> dict[str, str]:
    paths = {BACKEND / file for selectors in SUITES.values() for file in selectors}
    paths.update((BACKEND / "app").rglob("*.py"))
    paths.update((BACKEND / "app/plugins/skills/builtin").rglob("SKILL.md"))
    paths.update({BACKEND / "tests/conftest.py", Path(__file__), ROOT / "scripts/runtime_doctor.py"})
    return {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(paths) if path.is_file()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "docs/design/runtime-evaluation.md")
    parser.add_argument("--timeout", type=int, default=240, help="Maximum seconds per suite")
    args = parser.parse_args()
    rows = []
    before = source_hashes()
    with tempfile.TemporaryDirectory(prefix="octopus-runtime-evaluation-") as directory:
        for name, tests in SUITES.items():
            xml = Path(directory) / f"{name}.xml"
            command = [sys.executable, "-m", "pytest", *tests, "-q", "--tb=short", f"--junitxml={xml}"]
            began = time.monotonic()
            try:
                result = subprocess.run(command, cwd=BACKEND, text=True, encoding="utf-8", errors="replace",
                                        capture_output=True, timeout=args.timeout, check=False)
                exit_code, output = result.returncode, result.stdout + result.stderr
            except subprocess.TimeoutExpired:
                exit_code, output = None, "Suite timeout. No passing result is inferred."
            counts = junit_counts(xml)
            rows.append({"suite": name, "selectors": tests, "exit_code": exit_code,
                         "seconds": round(time.monotonic() - began, 2), **counts,
                         "command": subprocess.list2cmdline(["python", "-m", "pytest", *tests, "-q", "--tb=short"]),
                         "failure_output": output[-16000:].replace(str(ROOT), "<repository>").replace(str(Path.home()), "<user-home>") if exit_code != 0 else ""})
            print(f"{name}: {counts['passed']} passed; exit={exit_code}", flush=True)
    hashes = source_hashes()
    changed = sorted(path for path in before.keys() | hashes.keys() if before.get(path) != hashes.get(path))
    report = {"schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
              "python": "backend virtual environment", "python_version": platform.python_version(), "platform": platform.system(),
              "cwd": "backend", "suites": rows, "source_sha256": hashes,
              "source_changed_during_run": changed, "source_stable": not changed,
              "historical_baseline": {"passed": 25, "comparable": False,
                "reason": "Prior selected-test record; exact revision and selector set were not recorded here."},
              "live_model_prompts": 0, "quality_comparison": "Not evaluated"}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.with_suffix(".json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    lines = ["# Runtime reliability evaluation", "", f"Generated: {report['generated_at']}", "",
        "This report runs deterministic scripted native and fake ACP fixtures, with actual local MCP transport, "
        "filesystem, database and subprocess behavior where the selected tests exercise them. No inference calls "
        "or model-quality comparisons are performed. Passing checks establish only their asserted behavior.", "",
        "| Suite | Passed | Failed | Errors | Skipped | Seconds | Exit |", "| --- | ---: | ---: | ---: | ---: | ---: | --- |"]
    for row in rows:
        lines.append(f"| {row['suite']} | {row['passed']} | {row['failures']} | {row['errors']} | {row['skipped']} | {row['seconds']} | {row['exit_code']} |")
    if changed:
        lines += ["", "Sources changed while these suites ran. This is a mixed-source observation, not certification "
                  "of the current artifact. Rerun after these files stop changing: " + ", ".join(changed), ""]
    lines += ["", "| Fixture (each native and ACP) | Observable acceptance |", "| --- | --- |",
        "| Explain | Inspect app.py and record a source-linked answer without changing it |",
        "| Fix | Observe a failing unittest, change the source, rerun a passing current-revision check |",
        "| Build | Record acceptance and design, create app.py, and run the existing unittest against it |",
        "| Review | Inspect externally authored app.py and record a scoped clean verdict without editing |",
        "", "Eight additional native/ACP cases reject missing passing proof, skipped prerequisite checkpoints, "
        "and failure to replay the original reproduction command. "
        "These small fixtures verify the workflow machinery; they do not establish complex-task success, "
        "independent review quality, or the installed CLI's compliance with prompts.", "",
        "The historical baseline recorded 25 selected tests passing. Its selector set/revision differs or is "
        "unavailable, so counts cannot establish a reliability gain. Model output quality, cost and latency remain "
        "unmeasured. A future paired baseline/candidate run must use identical tasks, acceptance checks, model "
        "versions, budgets and repetitions; score blind review separately from deterministic reliability. "
        "The comparative promotion condition has not been met. Arena and swarm remain optional bounded strategy "
        "contracts; this report does not justify making either a default.", "",
        "Run from the repository root with the existing backend environment:", "",
        "```powershell", r"backend\.venv\Scripts\python.exe scripts/evaluate_runtime.py", "```", "",
        "Exact suite commands below run with `backend` as the working directory. The adjacent JSON records "
        "source hashes, selector sets, timestamps and failures. JUnit is used for counts, not parsed console text.", ""]
    for row in rows:
        lines += [f"- `{row['command']}`"]
        if row["failure_output"]:
            lines += ["", "```text", row["failure_output"], "```", ""]
    args.out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0 if not changed and all(row["exit_code"] == 0 and row["tests"] > 0 for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
