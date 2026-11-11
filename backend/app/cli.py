"""Octopus command line: the one launcher. ``python -m app.cli <setup|start|dev|check|test>``.

``start`` builds the UI when a source file is newer than the build, then serves the UI and the API on one URL
(``OCTOPUS_PORT``, default 8000). ``dev`` puts Vite on that same URL and the backend on a nearby free internal port;
Vite proxies ``/api``, ``/ws`` and the API docs, so the browser always talks to one origin and hot reload happens natively.

Only the standard library is imported at module level: ``setup`` has to run before the backend environment exists.
uvicorn and watchfiles are imported inside the commands that need them.
"""
from __future__ import annotations

import argparse
import os
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

# This file is backend/app/cli.py, so the repository root is two levels above its directory.
ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
DIST = FRONTEND / "dist"
NODE_MODULES = FRONTEND / "node_modules"
# Folders that never contain UI source worth rebuilding for.
SKIP_SCAN = {"node_modules", "dist", "test-results", ".vite", "__pycache__"}


class LauncherError(RuntimeError):
    """A problem the user can fix: printed as one line, without a traceback."""


def venv_python() -> Path:
    return BACKEND / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def dotenv_value(key: str) -> str:
    """Read one key from backend/.env or .env without importing the settings stack (setup runs before it exists)."""
    for path in (BACKEND / ".env", ROOT / ".env"):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            name, separator, value = line.partition("=")
            if separator and name.strip() == key:
                return value.split("#")[0].strip().strip("'\"")
    return ""


def env_value(key: str) -> str:
    return os.environ.get(key) or dotenv_value(key)


def public_port(args: argparse.Namespace) -> int:
    try:
        port = int(args.port or env_value("OCTOPUS_PORT") or 8000)
    except ValueError as exc:
        raise LauncherError("OCTOPUS_PORT must be a number between 1024 and 65535.") from exc
    if not 1024 <= port <= 65535:
        raise LauncherError("The public port must be between 1024 and 65535.")
    return port


def run(argv: list[object], cwd: Path | None = None) -> None:
    printable = " ".join(str(part) for part in argv)
    print(f"+ {printable}", flush=True)
    result = subprocess.run([str(part) for part in argv], cwd=str(cwd or ROOT))
    if result.returncode:
        raise LauncherError(f"Command failed with exit code {result.returncode}: {printable}")


def npm_command() -> str:
    npm = shutil.which("npm")
    if not npm:
        raise LauncherError("npm was not found. Install Node.js 24.15+ (or 22.22.2+) and open a new terminal.")
    return npm


def node_version() -> tuple[int, int, int]:
    node = shutil.which("node")
    if not node:
        raise LauncherError("node was not found. Install Node.js 24.15+ (or 22.22.2+) and open a new terminal.")
    out = subprocess.run([node, "-p", "process.versions.node"], capture_output=True, text=True)
    if out.returncode:
        raise LauncherError("node could not report its version. Reinstall Node.js.")
    try:
        major, minor, patch = (int(part) for part in out.stdout.strip().split(".")[:3])
    except ValueError as exc:
        raise LauncherError("node returned an invalid version. Reinstall Node.js.") from exc
    return major, minor, patch


NODE_RANGE = "Node 24.15+ (or 22.22.2+)"


def node_supported(version: tuple[int, int, int]) -> bool:
    return version[0] >= 26 or (version[0] == 24 and version[1] >= 15) or (
        version[0] == 22 and (version[1], version[2]) >= (22, 2))


def require_node() -> None:
    version = node_version()
    if not node_supported(version):
        raise LauncherError(f"Node {'.'.join(map(str, version))} is unsupported. Install {NODE_RANGE}.")


def in_use(port: int) -> bool:
    """Can Octopus still take this loopback port? Only a bind probe answers that reliably on Windows."""
    if os.name != "nt":
        with socket.socket() as probe:
            probe.settimeout(0.2)
            return probe.connect_ex(("127.0.0.1", port)) == 0
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return True
    return False


def require_free(port: int, role: str) -> None:
    if in_use(port):
        raise LauncherError(f"Port {port} ({role}) is already in use. Stop that program, or pick another port with "
                            f"--port or OCTOPUS_PORT.")


def pick_free(start: int) -> int:
    """The internal dev port is never advertised, so it may move instead of failing on an unrelated local server."""
    end = min(start + 20, 65535)
    for candidate in range(start, end + 1):
        if not in_use(candidate):
            return candidate
    raise LauncherError(f"No free port between {start} and {end} for the backend behind the dev server.")


def wait_http(url: str, timeout: float, headers: dict[str, str] | None = None) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(url, headers=headers or {})
            with urllib.request.urlopen(request, timeout=2) as response:
                if response.status < 500:
                    return True
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.2)
    return False


def announce(port: int, ready_url: str) -> None:
    """Print the one public URL only once it actually answers."""

    def wait_then_print() -> None:
        if wait_http(ready_url, 120):
            print(f"\nOctopus: http://127.0.0.1:{port}  (Ctrl+C to stop)\n", flush=True)
        else:
            print(f"\nThe backend is up but http://127.0.0.1:{port} did not answer. Check the log above.\n",
                  flush=True)

    threading.Thread(target=wait_then_print, daemon=True).start()


def wait_dev_ready(port: int, api_port: int, vite: subprocess.Popen, backend: subprocess.Popen) -> None:
    deadline = time.monotonic() + 120
    internal_url = f"http://127.0.0.1:{api_port}/api/health"
    public_url = f"http://127.0.0.1:{port}/api/health"
    host = {"Host": f"127.0.0.1:{port}"}
    while time.monotonic() < deadline:
        if backend.poll() is not None:
            raise LauncherError("The backend file watcher stopped before the API became ready. Check the error above.")
        if vite.poll() is not None:
            raise LauncherError("Vite stopped before the public URL became ready. Check the error above.")
        if wait_http(internal_url, 0.2, host) and wait_http(public_url, 0.2):
            print(f"\nOctopus: http://127.0.0.1:{port}  (Ctrl+C to stop)\n", flush=True)
            return
        time.sleep(0.2)
    raise LauncherError("Octopus did not become ready within two minutes. Check the error above.")


def newest_source_mtime() -> float:
    newest = 0.0
    for base, dirs, files in os.walk(FRONTEND):
        dirs[:] = [name for name in dirs if name not in SKIP_SCAN]
        for name in files:
            try:
                newest = max(newest, (Path(base) / name).stat().st_mtime)
            except OSError:
                continue
    return newest


def ui_is_stale() -> bool:
    index = DIST / "index.html"
    return not index.is_file() or newest_source_mtime() > index.stat().st_mtime


def build_ui(skip: bool) -> None:
    if skip:
        if not (DIST / "index.html").is_file():
            raise LauncherError("The UI build is missing. Run again without --skip-build / OCTOPUS_SKIP_BUILD.")
        print("Using the existing UI build.", flush=True)
        return
    if not ui_is_stale():
        print("UI build is up to date; skipping the build.", flush=True)
        return
    require_node()
    if not NODE_MODULES.is_dir():
        raise LauncherError("Frontend dependencies are missing. Run: octopus.ps1 setup  (or: make setup)")
    print("Building the UI...", flush=True)
    run([npm_command(), "run", "build"], cwd=FRONTEND)


def serve(port: int, log_level: str = "warning") -> None:
    import uvicorn

    try:
        uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level=log_level, access_log=False)
    except OSError as exc:
        raise LauncherError(f"Could not listen on port {port}: {exc}") from exc


def require_backend(*, dev_mode: bool = False) -> None:
    if not venv_python().is_file():
        raise LauncherError("Backend is not installed. Run: octopus.ps1 setup  (or: make setup)")
    imports = "import fastapi, uvicorn" + ("; import watchfiles" if dev_mode else "")
    result = subprocess.run([str(venv_python()), "-c", imports], capture_output=True)
    if result.returncode:
        raise LauncherError("Backend dependencies are incomplete. Run: octopus.ps1 setup  (or: make setup)")


def stop_tree(process: subprocess.Popen) -> None:
    """Stop the child and everything it started, so Ctrl+C leaves no orphan Vite or esbuild behind."""
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def spawn_vite(port: int, api_port: int) -> subprocess.Popen:
    dev_server = FRONTEND / "scripts" / "dev-server.mjs"
    if not dev_server.is_file() or not (NODE_MODULES / "vite" / "package.json").is_file():
        raise LauncherError("Vite is missing. Run: octopus.ps1 setup  (or: make setup)")
    node = shutil.which("node")
    if not node:
        raise LauncherError("node was not found. Install Node.js 24.15+ (or 22.22.2+) and open a new terminal.")
    env = {**os.environ, "OCTOPUS_PORT": str(port), "OCTOPUS_API": f"http://127.0.0.1:{api_port}", "BROWSER": "none"}
    return subprocess.Popen(
        [node, str(dev_server)],
        cwd=str(FRONTEND), env=env, start_new_session=os.name != "nt")


def spawn_backend_watch(port: int) -> subprocess.Popen:
    return subprocess.Popen(
        [str(venv_python()), "-m", "app.cli", "_backend-watch", "--port", str(port)],
        cwd=str(BACKEND), env=os.environ.copy(), start_new_session=os.name != "nt")


def setup(args: argparse.Namespace) -> int:
    python = args.python or sys.executable
    version = subprocess.run([python, "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
                             capture_output=True, text=True)
    try:
        python_version = tuple(int(part) for part in version.stdout.strip().split("."))
    except ValueError:
        python_version = ()
    if version.returncode or python_version < (3, 11):
        raise LauncherError("Python 3.11 or newer is required to create the backend environment.")
    require_node()
    npm = npm_command()
    if not venv_python().is_file():
        print(f"Creating the backend environment in {BACKEND / '.venv'} ...", flush=True)
        run([python, "-m", "venv", BACKEND / ".venv"])
    venv = str(venv_python())
    run([venv, "-m", "ensurepip", "--upgrade"])
    run([venv, "-m", "pip", "install", "--upgrade", "pip"], cwd=BACKEND)
    run([venv, "-m", "pip", "install", "-r", BACKEND / "requirements.txt"], cwd=BACKEND)
    run([npm, "ci", "--prefix", FRONTEND, "--no-audit", "--no-fund"])
    print("Setup complete. Run: octopus.ps1 start  (or: make start)", flush=True)
    return 0


def start(args: argparse.Namespace) -> int:
    port = public_port(args)
    os.environ["OCTOPUS_PORT"] = str(port)
    require_backend()
    require_free(port, "the public URL")
    build_ui(args.skip_build)
    print("Starting Octopus ...", flush=True)
    announce(port, f"http://127.0.0.1:{port}/api/health")
    serve(port)
    return 0


def dev(args: argparse.Namespace) -> int:
    port = public_port(args)
    if port == 65535:
        raise LauncherError("Development needs an internal backend port after the public port. Choose 65534 or lower.")
    os.environ["OCTOPUS_PORT"] = str(port)
    require_backend(dev_mode=True)
    require_node()
    if not NODE_MODULES.is_dir():
        raise LauncherError("Frontend dependencies are missing. Run: octopus.ps1 setup  (or: make setup)")
    require_free(port, "the public URL")
    api_port = pick_free(port + 1)
    print("Starting Octopus development ...", flush=True)
    backend = spawn_backend_watch(api_port)
    vite: subprocess.Popen | None = None
    try:
        vite = spawn_vite(port, api_port)
        wait_dev_ready(port, api_port, vite, backend)
        while True:
            if backend.poll() is not None:
                raise LauncherError("The backend file watcher stopped. Check the error above.")
            if vite.poll() is not None:
                raise LauncherError("Vite stopped. Check the error above.")
            time.sleep(0.2)
    finally:
        if vite is not None:
            stop_tree(vite)
        stop_tree(backend)
    return 0


def _dev_serve(port: int) -> None:
    # Each reload child owns its listening socket; keeping Vite out of this process leaves both reloads independent.
    serve(port, log_level="warning")


def backend_watch(args: argparse.Namespace) -> int:
    from watchfiles import run_process

    run_process(BACKEND / "app", target=_dev_serve, args=(args.port,))
    return 0


def check(args: argparse.Namespace) -> int:
    port = public_port(args)
    problems: list[str] = []
    print(f"Python {sys.version.split()[0]}")
    if sys.version_info < (3, 11):
        problems.append("Python 3.11 or newer is required.")
    venv = venv_python()
    if not venv.is_file():
        problems.append("Backend environment is missing. Run: octopus.ps1 setup  (or: make setup)")
    else:
        probe = subprocess.run([str(venv), "-c", "import fastapi, uvicorn, watchfiles"], capture_output=True)
        if probe.returncode:
            problems.append("Backend dependencies are missing. Run: octopus.ps1 setup")
    try:
        version = node_version()
        shown = ".".join(map(str, version))
        print(f"Node {shown}")
        if not node_supported(version):
            problems.append(f"Node {shown} is older than the tested range ({NODE_RANGE}).")
    except LauncherError as exc:
        problems.append(str(exc))
    if not NODE_MODULES.is_dir():
        problems.append("Frontend dependencies are missing. Run: octopus.ps1 setup")
    print(f"UI build: {'stale' if ui_is_stale() else 'up to date'}")
    print(f"Port {port} (public): {'in use' if in_use(port) else 'free'}")
    if port == 65535:
        problems.append("Development requires a public port of 65534 or lower.")
    else:
        print(f"Dev backend port: chosen automatically from {port + 1} (never printed, never bookmarked)")
    if problems:
        print("\n".join(f"- {problem}" for problem in problems), file=sys.stderr)
        return 1
    print("Everything Octopus needs is installed.")
    return 0


def test(args: argparse.Namespace) -> int:
    require_backend()
    require_node()
    npm = npm_command()
    if not NODE_MODULES.is_dir():
        raise LauncherError("Frontend dependencies are missing. Run: octopus.ps1 setup  (or: make setup)")
    run([str(venv_python()), "-m", "pytest", "-q"], cwd=BACKEND)
    run([npm, "run", "typecheck"], cwd=FRONTEND)
    run([npm, "test"], cwd=FRONTEND)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="octopus", description="Start, develop, check and test Octopus.")
    commands = parser.add_subparsers(dest="command")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, default=None,
                        help="public port (default: OCTOPUS_PORT, else 8000)")
    common.add_argument("--skip-build", action="store_true",
                        default=env_value("OCTOPUS_SKIP_BUILD").lower() in {"1", "true", "yes"},
                        help="serve the existing UI build instead of rebuilding it")
    common.add_argument("--python", default=None, help="Python used to create the backend environment (setup only)")
    commands.add_parser("setup", parents=[common], help="create the backend environment and install frontend deps")
    commands.add_parser("start", parents=[common], help="build the UI when stale, then serve one URL")
    commands.add_parser("dev", parents=[common], help="hot reload: Vite on the public port, backend on an internal port")
    commands.add_parser("check", parents=[common], help="report missing prerequisites without changing anything")
    commands.add_parser("test", parents=[common], help="run the backend and frontend test suites")
    return parser


def main(argv: list[str] | None = None) -> int:
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    parser = build_parser()
    arguments = sys.argv[1:] if argv is None else argv
    if arguments[:1] == ["_backend-watch"]:
        internal = argparse.ArgumentParser(add_help=False)
        internal.add_argument("--port", type=int, required=True)
        return backend_watch(internal.parse_args(arguments[1:]))
    args = parser.parse_args(arguments)
    handlers = {"setup": setup, "start": start, "dev": dev, "check": check, "test": test}
    if args.command not in handlers:
        parser.print_help()
        return 2
    try:
        return handlers[args.command](args)
    except LauncherError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nStopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
