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
    # Scripted demos and compatibility harnesses explicitly disable strict verification.
    # Real runs enable it by default and cannot finish green with work left open.
    if open_tasks and require_verification:
        blockers.append(f"{len(open_tasks)} unfinished task(s)")
    if broken_files:
        blockers.append("syntax checks failing: " + ", ".join(sorted(broken_files)[:6]))
    if require_verification and unverified:
        blockers.append("changes not verified by a successful command or browser check: "
                        + ", ".join(sorted(unverified)[:6]))
    return ("incomplete", "; ".join(blockers)[:2000]) if blockers else (status, reason)

def command_is_verification(command: str, changed_paths: list[str]) -> bool:
    """A successful unrelated command must not certify modified code."""
    import re

    command = command.strip().lower()
    if re.search(r"\b(pytest|unittest|vitest|jest|playwright|cargo test|go test|gradle\w* test|gradlew test|mvn test|flutter test|"
                 r"npm (?:run )?(?:test|build|lint|typecheck)|pnpm (?:run )?(?:test|build|lint|typecheck)|"
                 r"yarn (?:test|build|lint|typecheck)|make (?:test|check|build)|"
                 r"py_compile|compileall|tsc|ruff check|node --check)\b", command):
        return True
    # A successful unrelated command ("echo app.py" or "ls app.py") proves nothing.
    import shlex

    try:
        args = shlex.split(command)
    except ValueError:
        return False
    if not args or args[0].rsplit("/", 1)[-1] not in (
            "python", "python3", "node", "bun", "deno", "ruby", "php", "bash", "sh"):
        return False
    if any(flag in args for flag in ("-c", "-e", "-p", "--version")):
        return False
    candidates = [arg.replace(chr(92), "/").removeprefix("./").lower()
                  for arg in args[1:] if not arg.startswith("-")]
    return any(candidate == path.lower() or candidate == path.lower().split("/")[-1]
               for candidate in candidates for path in changed_paths if path)
