"""Sandboxed command execution pinned to the project directory.

Backends:
- ``subprocess`` (default, local): no shell, scrubbed environment, POSIX rlimits (CPU, memory, file size,
  processes), wall-clock timeout, output caps, ``cwd`` = project root. Network is disabled with
  ``unshare -n`` when the OS allows it.
- ``docker``: throwaway container, ``--network none``, memory/CPU/pids caps, read-only root FS,
  project mounted at /work.

Every approval mode uses the same rules: one allowlisted program, no shell, no network. Arguments that point outside the
project folder are returned to the caller, which asks the user before running that command. ``.git`` and Octopus data
stay protected in all cases.
"""
from __future__ import annotations

import asyncio
import codecs
import os
import shlex
import shutil
import signal
import sys
from dataclasses import dataclass
from pathlib import Path

from app.foundation.config import get_settings

ALLOWED_PREFIXES: list[list[str]] = [
    ["python"], ["python3"], ["node"], ["pytest"], ["npm", "test"], ["npm", "run"], ["npm", "ci"], ["npm", "install"],
    ["npm", "create"], ["npm", "init"], ["npx", "vitest", "run"], ["npx", "create-vite"],
    ["git", "status"], ["git", "diff"], ["git", "log"], ["git", "commit"], ["git", "push"], ["ls"], ["go", "test"], ["go", "build"], ["go", "run"],
    ["cargo", "test"], ["cargo", "build"], ["cargo", "run"], ["flutter"], ["dart"], ["dotnet"],
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


def shell_operators(command: str) -> list[str]:
    """Shell operators that a shell would act on: outside quotes only.

    Commands run without a shell, so ``node -e "const f = () => a && b"`` or ``python -c "if a < b: ..."`` are harmless:
    their operators are inside one quoted argument. The old substring check rejected those (and every multi-line script),
    which is what made agents give up on running and testing their own code."""
    ops: list[str] = []
    quote: str | None = None
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
        elif c == "\\":
            i += 2
            continue
        elif c in "'\"":
            quote = c
        elif command.startswith("$(", i):
            ops.append("$(")
        elif c in FORBIDDEN_TOKENS or c == "&":
            ops.append("newline" if c == "\n" else c)
        i += 1
    return ops


def needs_shell(command: str) -> bool:
    return bool(shell_operators(command))


@dataclass(frozen=True)
class CommandPlan:
    argv: list[str]
    outside: list[str]  # arguments that point outside the project folder; running the command needs the user's approval


def _path_parts(argument: str) -> tuple[str, list[str]]:
    value = argument.split("=", 1)[-1] if argument.startswith("-") and "=" in argument else argument
    value = value.replace("\\", "/")
    return value, value.lower().split("/")


def analyze_command(command: str) -> CommandPlan:
    """Check ``command`` against the sandbox rules.

    Raises ``SandboxError`` for anything that can never run: shell operators, programs outside the allowlist, inline code,
    blocked programs, and ``.git`` or Octopus internals. Arguments that point outside the project are not an error here.
    They come back in ``CommandPlan.outside`` so the caller can ask the user first."""
    ops = shell_operators(command)
    if ops:
        raise SandboxError(f"Shell operators ({' '.join(sorted(set(ops)))}) are not allowed; run one command per call "
                           "(quoted arguments may contain any characters), or write a script file and run that")
    try:
        argv = shlex.split(command, comments=False)
    except ValueError as exc:
        raise SandboxError(f"Could not parse command: {exc}") from exc
    if not argv:
        raise SandboxError("Empty command")
    exe = os.path.basename(argv[0])
    if exe in BLOCKED_ALWAYS:
        raise SandboxError(f"'{exe}' is blocked")
    if not any(argv[: len(p)] == p for p in ALLOWED_PREFIXES):
        allowed = ", ".join(" ".join(p) for p in ALLOWED_PREFIXES)
        raise SandboxError(f"Command not allowed. Allowed: {allowed}.")
    if len(argv) > 2 and exe in ("python", "python3", "node") and argv[1] in ("-c", "-e", "--eval"):
        raise SandboxError("Inline code (-c / -e) is not allowed; write a file first")
    outside: list[str] = []
    for argument in argv[1:]:
        value, parts = _path_parts(argument)
        if ".octopus" in parts or ".git" in parts:
            raise SandboxError("Octopus data and .git internals are protected")
        if value.startswith(("/", "~")) or (len(value) > 1 and value[1] == ":") or ".." in parts:
            outside.append(argument)
    return CommandPlan(argv=argv, outside=outside)


def parse_command(command: str, *, allow_outside: bool = False) -> list[str]:
    """Return the argv for ``command``. Paths outside the project raise unless ``allow_outside`` is set. Only set it after
    the user approved that command."""
    plan = analyze_command(command)
    if plan.outside and not allow_outside:
        raise SandboxError("Arguments may not reference paths outside the project directory")
    return plan.argv


def _limits(memory_mb: int, cpu_s: int, *, address_space: bool = True):  # type: ignore[no-untyped-def]
    def apply() -> None:  # runs in the child before exec
        import resource

        mem = memory_mb * 1024 * 1024
        # CPU: SIGXCPU at the soft limit, SIGKILL one second later at the hard limit
        limits = [(resource.RLIMIT_CPU, cpu_s, cpu_s + 1), (resource.RLIMIT_FSIZE, 50 * 1024 * 1024, 50 * 1024 * 1024), (resource.RLIMIT_NPROC, 512, 512)]
        if address_space:
            limits.append((resource.RLIMIT_AS, mem, mem))
        for lim, soft, hard in limits:
            try:
                resource.setrlimit(lim, (soft, hard))
            except (ValueError, OSError):
                pass
        os.setsid()

    return apply


def _resolve_exe(argv: list[str], env: dict[str, str] | None = None) -> list[str]:
    path = (env or {}).get("PATH")
    if argv[0] in ("python", "python3"):
        return [shutil.which("python3", path=path) or shutil.which("python", path=path) or sys.executable, *argv[1:]]
    if argv[0] == "pytest":
        pytest = shutil.which("pytest", path=path)
        return [pytest or (shutil.which("python3", path=path) or sys.executable), *([] if pytest else ["-m", "pytest"]), *argv[1:]]
    if os.name == "nt" and argv[0] in ("npm", "npx"):
        launcher = shutil.which(f"{argv[0]}.cmd", path=path)
        node = shutil.which("node", path=path)
        if launcher and node:
            cli = Path(launcher).parent / "node_modules" / "npm" / "bin" / f"{argv[0]}-cli.js"
            if cli.is_file():
                return [node, str(cli), *argv[1:]]
    if os.name == "nt":
        launcher = shutil.which(argv[0], path=path)
        if launcher:
            # Windows resolves SDK tools through .bat/.cmd launchers. Such files
            # implicitly invoke cmd.exe, so reject arguments it could reinterpret.
            if Path(launcher).suffix.lower() in (".bat", ".cmd") and any(
                character in argument for argument in argv[1:] for character in '&|<>^%!"\r\n'
            ):
                raise SandboxError("Windows batch launchers cannot safely receive shell characters in arguments. Use a native executable or a script file.")
            return [launcher, *argv[1:]]
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


def command_environment(cwd: Path, *, developer: bool = False) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(cwd), "PYTHONDONTWRITEBYTECODE": "1",
           "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1",
           "LANG": "C.UTF-8", "NO_COLOR": "1", "CI": "1", "TERM": "dumb"}
    if os.name == "nt":
        for key in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE"):
            if key in os.environ:
                env[key] = os.environ[key]
    for key in ("JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "FLUTTER_ROOT", "DART_SDK", "PUB_CACHE", "GRADLE_USER_HOME"):
        if key in os.environ:
            env[key] = os.environ[key]
    from app.plugins.workspace.worktrees import environment_directory
    venv = environment_directory(cwd)
    if venv:
        scripts = venv / ("Scripts" if os.name == "nt" else "bin")
        env["PATH"] = f"{scripts}{os.pathsep}{env['PATH']}"
        env["VIRTUAL_ENV"] = str(venv)
    if developer:
        env["HOME"] = os.environ.get("HOME") or os.environ.get("USERPROFILE") or str(Path.home())
    return env


async def stop_process(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(proc.pid), "/T", "/F",
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.wait()
            if proc.returncode is None:
                proc.kill()
    except OSError:
        if proc.returncode is None:
            proc.kill()
    await proc.wait()


async def bounded_output(proc: asyncio.subprocess.Process) -> str:
    """Drain the pipe without retaining unbounded build output in memory."""
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    head, tail = "", ""
    length = 0
    if proc.stdout:
        while block := await proc.stdout.read(8192):
            text = decoder.decode(block)
            length += len(text)
            if len(head) < 2000:
                head += text[:2000 - len(head)]
            tail = (tail + text)[-MAX_OUTPUT:]
        text = decoder.decode(b"", final=True)
        length += len(text)
        head += text[:max(0, 2000 - len(head))]
        tail = (tail + text)[-MAX_OUTPUT:]
    await proc.wait()
    if length <= MAX_OUTPUT:
        return tail
    return head + "\n... [truncated] ...\n" + tail[-(MAX_OUTPUT - 2000):]


async def _run_subprocess(argv: list[str], cwd: Path, timeout: int, memory_mb: int) -> ExecResult:
    env = command_environment(cwd)
    exe = _resolve_exe(argv, env)
    backend = "subprocess"
    if await _unshare_available():
        exe = [shutil.which("unshare") or "unshare", "-rn", "--", *exe]
        backend = "subprocess+netns"
    # V8 and Go reserve large virtual address ranges without using that much RAM.
    # RLIMIT_AS prevents these runtimes from starting; Docker caps resident memory.
    virtual_runtime = Path(argv[0]).name in {"node", "npm", "npx", "go", "java", "dart", "flutter"}
    preexec = _limits(memory_mb, timeout, address_space=not virtual_runtime) if os.name == "posix" else None
    try:
        proc = await asyncio.create_subprocess_exec(
            *exe, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, preexec_fn=preexec,
        )
    except FileNotFoundError as exc:
        return ExecResult(False, 127, f"Executable not found: {exc.filename or argv[0]}", backend=backend)
    try:
        text = await asyncio.wait_for(bounded_output(proc), timeout=timeout)
    except asyncio.TimeoutError:
        await stop_process(proc)
        return ExecResult(False, -9, f"Timed out after {timeout}s", timed_out=True, backend=backend)
    if os.name == "posix" and proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
        # killed by the CPU-time limit (a busy process can burn `timeout` CPU seconds before the wall clock runs out)
        return ExecResult(False, -9, f"{text}\nTimed out: CPU time limit of {timeout}s exceeded".lstrip(), timed_out=True, backend=backend)
    return ExecResult(proc.returncode == 0, proc.returncode or 0, text, backend=backend)


async def _run_docker(argv: list[str], cwd: Path, timeout: int, memory_mb: int) -> ExecResult:
    s = get_settings()
    local_env_args: list[str] = []
    from app.plugins.workspace.worktrees import environment_directory
    venv = environment_directory(cwd)
    if venv:
        env_rel = venv.relative_to(cwd.resolve()).as_posix()
        local_env_args = ["-e", f"PATH=/work/{env_rel}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                          "-e", f"VIRTUAL_ENV=/work/{env_rel}"]
    cmd = ["docker", "run", "--rm", "--network", "none", "--memory", f"{memory_mb}m", "--cpus", "1",
           "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp", *local_env_args, "-v", f"{cwd}:/work", "-w", "/work",
           "--user", f"{os.getuid()}:{os.getgid()}" if hasattr(os, "getuid") else "1000:1000", s.sandbox_docker_image, *argv]
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        text = await asyncio.wait_for(bounded_output(proc), timeout=timeout + 15)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return ExecResult(False, -9, f"Timed out after {timeout}s", timed_out=True, backend="docker")
    return ExecResult(proc.returncode == 0, proc.returncode or 0, text, backend="docker")


async def run_command(command: str, cwd: Path, *, allow_outside: bool = False, timeout: int | None = None) -> ExecResult:
    s = get_settings()
    argv = parse_command(command, allow_outside=allow_outside)
    t = min(timeout or s.sandbox_timeout_s, s.sandbox_timeout_s)
    if s.sandbox_mode == "docker" and shutil.which("docker"):
        return await _run_docker(argv, cwd, t, s.sandbox_memory_mb)
    return await _run_subprocess(argv, cwd, t, s.sandbox_memory_mb)
