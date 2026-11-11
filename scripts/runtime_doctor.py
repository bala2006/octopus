#!/usr/bin/env python3
"""Inspect the existing local OpenCode installation; never install or prompt a model."""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import json
import platform
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.sdk.evidence import redact_evidence
from app.plugins.providers.opencode import executable, probe, process_options
from app.plugins.sandbox.commands import stop_process


async def inspect_command(argv: list[str], cwd: Path, timeout: float = 20) -> dict:
    process = None
    try:
        process = await asyncio.create_subprocess_exec(*argv, cwd=cwd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, **process_options())
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
        return {"exit_code": process.returncode, "output": redact_evidence(output.decode("utf-8", "replace"))}
    except (OSError, TimeoutError) as exc:
        return {"exit_code": None, "error": redact_evidence(str(exc) or "Timed out")}
    finally:
        if process and process.returncode is None:
            await stop_process(process)


async def collect() -> dict:
    report = {
        "schema_version": 1, "generated_at": datetime.now(timezone.utc).isoformat(),
        "platform": platform.system(), "python_version": platform.python_version(),
        "node_on_path": bool(shutil.which("node")),
        "policy": {"installed_existing_cli_only": True, "downloads": False, "model_prompts": 0,
                   "working_directory": "disposable temporary directory", "configuration_written": False},
        "limitations": ["Discovery lists configured models; it does not test access or quality.",
            "ACP initialization creates an empty session in the CLI's own storage; no inference prompt is sent.",
            "The CLI can load inherited host configuration. A temporary working directory is not a sandbox.",
            "Advertised capabilities are not proof of filesystem, network or permission isolation."],
    }
    try:
        argv = executable()
    except Exception as exc:
        report["opencode"] = {"available": False, "error": redact_evidence(str(exc))}
        return report
    with tempfile.TemporaryDirectory(prefix="octopus-runtime-doctor-", ignore_cleanup_errors=True) as directory:
        cwd = Path(directory)
        version = await inspect_command([*argv, "--version"], cwd)
        discovery = await inspect_command([*argv, "models"], cwd)
        models = sorted(set(line.strip() for line in discovery.get("output", "").splitlines()
                            if "/" in line.strip() and not any(c.isspace() for c in line.strip())))
        handshake = (await probe(cwd)).model_dump(mode="json")
    report["temporary_directory_cleaned"] = not cwd.exists()
    if cwd.exists():
        report["limitations"].append("The installed CLI retained a temporary directory handle; directory cleanup is pending.")
    # Do not persist arbitrary config option values or provider credentials.
    options = handshake.pop("config_options", [])
    handshake["config_options"] = [
        {key: option[key] for key in ("id", "name", "category", "type") if key in option}
        for option in options]
    report["opencode"] = {"available": handshake["available"], "executable": [Path(item).name for item in argv],
        "version": version, "model_discovery": {"exit_code": discovery["exit_code"], "models": models,
            **({"error": discovery["error"]} if "error" in discovery else {})}, "acp": handshake}
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "docs/design/runtime-capabilities.json")
    args = parser.parse_args()
    report = asyncio.run(collect())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Runtime capability report: {args.out}")
    print(f"Existing OpenCode ACP available: {report['opencode']['available']}; model prompts sent: 0")
    return 0 if report["opencode"]["available"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
