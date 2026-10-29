"""Deterministic outcome semantics: finishing is not the same as verification."""
from __future__ import annotations
from typing import Any


def assess_completion(status: str, reason: str, *, workflow: dict[str, Any] | None,
                      open_tasks: list[dict[str, Any]], broken_files: dict[str, str],
                      unverified: dict[str, int], require_verification: bool) -> tuple[str, str]:
    if status != "completed":
        return status, reason
    blockers: list[str] = []
    phases = (workflow or {}).get("phases", [])
    failed = [p["key"] for p in phases if p.get("status") == "failed"]
    if failed:
        blockers.append("failed workflow phase(s): " + ", ".join(failed))
    pending = [p["key"] for p in phases if p.get("status") in ("active", "pending")]
    if pending and not (workflow or {}).get("ended"):
        blockers.append("unfinished workflow phase(s): " + ", ".join(pending))
    if open_tasks:
        blockers.append(f"{len(open_tasks)} unfinished task(s)")
    if broken_files:
        blockers.append("syntax checks failing: " + ", ".join(sorted(broken_files)[:6]))
    if require_verification and unverified:
        blockers.append("changes not verified by a successful command or browser check: "
                        + ", ".join(sorted(unverified)[:6]))
    return ("incomplete", "; ".join(blockers)[:2000]) if blockers else (status, reason)
