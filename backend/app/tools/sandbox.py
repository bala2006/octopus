"""Sandboxed command execution pinned to the project directory.

Backends:
- ``subprocess`` (default, local): no shell, scrubbed environment, POSIX rlimits (CPU, memory, file size,
  processes), wall-clock timeout, output caps, ``cwd`` = project root. Network is disabled with
  ``unshare -n`` when the OS allows it (not in danger mode).
- ``docker``: throwaway container, ``--network none``, memory/CPU/pids caps, read-only root FS,
  project mounted at /work.

Permission levels: outside ``danger`` mode only allowlisted commands run; ``danger`` allows any
single command (still no shell operators, no paths outside the project, same limits).
"""
from __future__ import annotations

import asyncio
import os
import shlex
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings

ALLOWED_PREFIXES: list[list[str]] = [
    ["python"], ["python3"], ["node"], ["pytest"], ["npm", "test"], ["npm", "run"], ["npx", "vitest", "run"],
    ["git", "status"], ["git", "diff"], ["git", "log"], ["ls"], ["go", "test"], ["cargo", "test"],
]
FORBIDDEN_TOKENS = [";", "&&", "||", "|", ">", "<", "`", "$(", "\n"]
BLOCKED_ALWAYS = {"sudo", "su", "rm", "shutdown", "reboot", "mkfs", "dd", "chmod", "chown", "curl", "wget", "ssh", "scp"}
MAX_OUTPUT = 12_000


@dataclass
class ExecResult:
    ok: bool
    exit_code: int
    output: str
    timed_out: bool = False
    backend: str = "subprocess"


class SandboxError(ValueError):
    pass


def parse_command(command: str, *, danger: bool = False) -> list[str]:
    if any(tok in command for tok in FORBIDDEN_TOKENS):
        raise SandboxError("Shell operators (; && || | > < ` $()) are not allowed; run a single command")
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise SandboxError(f"Could not parse command: {exc}") from exc
    if not argv:
        raise SandboxError("Empty command")
    exe = os.path.basename(argv[0])
    if exe in BLOCKED_ALWAYS and not danger:
        raise SandboxError(f"'{exe}' is blocked; it requires danger mode")
    if not danger and not any(argv[: len(p)] == p for p in ALLOWED_PREFIXES):
        allowed = ", ".join(" ".join(p) for p in ALLOWED_PREFIXES)
        raise SandboxError(f"Command not allowed in this permission level. Allowed: {allowed}. (Danger mode allows any command.)")
    for a in argv[1:]:
        if a.startswith(("/", "~")) or ".." in a.replace("\\", "/").split("/"):
            raise SandboxError("Arguments may not reference paths outside the project directory")
        if ".octopus" in a.split("/") or a.startswith(".git/"):
            raise SandboxError("Octopus data and .git internals are protected")
    if not danger and exe in ("python", "python3", "node") and len(argv) > 1 and argv[1] in ("-c", "-e", "--eval"):
        raise SandboxError("Inline code (-c / -e) is not allowed; write a file first")
    return argv


def _limits(memory_mb: int, cpu_s: int):  # type: ignore[no-untyped-def]
    def apply() -> None:  # runs in the child before exec
        import resource

        mem = memory_mb * 1024 * 1024
        for lim, val in ((resource.RLIMIT_AS, mem), (resource.RLIMIT_CPU, cpu_s), (resource.RLIMIT_FSIZE, 50 * 1024 * 1024),
                         (resource.RLIMIT_NPROC, 512)):
            try:
                resource.setrlimit(lim, (val, val))
            except (ValueError, OSError):
                pass
        os.setsid()

    return apply


def _resolve_exe(argv: list[str]) -> list[str]:
    if argv[0] in ("python", "python3"):
        return [shutil.which("python3") or sys.executable, *argv[1:]]
    if argv[0] == "pytest":
        return [shutil.which("pytest") or sys.executable, *([] if shutil.which("pytest") else ["-m", "pytest"]), *argv[1:]]
    return argv


_UNSHARE_OK: bool | None = None


async def _unshare_available() -> bool:
    global _UNSHARE_OK
    if _UNSHARE_OK is None:
        path = shutil.which("unshare")
        if not path or os.name != "posix":
            _UNSHARE_OK = False
        else:
            p = await asyncio.create_subprocess_exec(path, "-rn", "true", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            _UNSHARE_OK = (await p.wait()) == 0
    return _UNSHARE_OK


async def _run_subprocess(argv: list[str], cwd: Path, timeout: int, memory_mb: int, *, network: bool) -> ExecResult:
    exe = _resolve_exe(argv)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cwd), "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONUNBUFFERED": "1", "LANG": "C.UTF-8", "NO_COLOR": "1", "CI": "1", "TERM": "dumb"}
    backend = "subprocess"
    if not network and await _unshare_available():
        exe = [shutil.which("unshare") or "unshare", "-rn", "--", *exe]
        backend = "subprocess+netns"
    preexec = _limits(memory_mb, timeout) if os.name == "posix" else None
    try:
        proc = await asyncio.create_subprocess_exec(
            *exe, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, preexec_fn=preexec,
        )
    except FileNotFoundError as exc:
        return ExecResult(False, 127, f"Executable not found: {exc.filename or argv[0]}", backend=backend)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        try:
            os.killpg(proc.pid, 9)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        await proc.wait()
        return ExecResult(False, -9, f"Timed out after {timeout}s", timed_out=True, backend=backend)
    text = out.decode("utf-8", errors="replace")
    if len(text) > MAX_OUTPUT:
        text = text[:2000] + "\n... [truncated] ...\n" + text[-(MAX_OUTPUT - 2000):]
    return ExecResult(proc.returncode == 0, proc.returncode or 0, text, backend=backend)


async def _run_docker(argv: list[str], cwd: Path, timeout: int, memory_mb: int, *, network: bool) -> ExecResult:
    s = get_settings()
    cmd = ["docker", "run", "--rm", "--network", "bridge" if network else "none", "--memory", f"{memory_mb}m", "--cpus", "1",
           "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp", "-v", f"{cwd}:/work", "-w", "/work",
           "--user", f"{os.getuid()}:{os.getgid()}" if hasattr(os, "getuid") else "1000:1000", s.sandbox_docker_image, *argv]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 15)
    except asyncio.TimeoutError:
        proc.kill()
        return ExecResult(False, -9, f"Timed out after {timeout}s", timed_out=True, backend="docker")
    text = out.decode("utf-8", errors="replace")[-MAX_OUTPUT:]
    return ExecResult(proc.returncode == 0, proc.returncode or 0, text, backend="docker")


async def run_command(command: str, cwd: Path, *, danger: bool = False, timeout: int | None = None) -> ExecResult:
    s = get_settings()
    argv = parse_command(command, danger=danger)
    t = min(timeout or s.sandbox_timeout_s, s.sandbox_timeout_s)
    if s.sandbox_mode == "docker" and shutil.which("docker"):
        return await _run_docker(argv, cwd, t, s.sandbox_memory_mb, network=danger)
    return await _run_subprocess(argv, cwd, t, s.sandbox_memory_mb, network=danger)
