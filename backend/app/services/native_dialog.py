"""Native "choose folder" dialog, shown by the local backend on the user's own desktop.

Octopus runs on the user's machine, so the backend can open the operating system's folder picker (the browser can't
reveal real paths). Every picker used here lets the user create a new folder too:

* macOS   — ``osascript`` (``choose folder``)
* Windows — PowerShell ``FolderBrowserDialog``
* Linux   — ``zenity``, ``kdialog`` or ``yad``; falls back to Tk's ``askdirectory``

When no desktop is available (Docker, SSH, CI) :func:`availability` says so. With Docker, the browser then asks the
laptop-side helper ``scripts/folder_bridge.py`` (which imports this module, so it must stay standard-library only), and
otherwise falls back to its built-in folder browser.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PROMPT = "Choose a project folder for Octopus"
TIMEOUT_S = 15 * 60


@dataclass
class Availability:
    available: bool
    method: str = ""
    reason: str = ""


class DialogError(RuntimeError):
    pass


def _has_display() -> bool:
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def _tk_available() -> bool:
    try:
        import tkinter  # noqa: F401
    except Exception:  # pragma: no cover - depends on the Python build
        return False
    return True


def availability(enabled: bool | None = None) -> Availability:
    if enabled is None:
        from app.core.config import get_settings  # lazy: the laptop-side helper has no backend dependencies

        enabled = get_settings().native_dialogs
    if not enabled:
        return Availability(False, reason="Native dialogs are disabled (NATIVE_DIALOGS=false)")
    if sys.platform == "darwin":
        return Availability(bool(shutil.which("osascript")), "osascript", "" if shutil.which("osascript") else "osascript not found")
    if sys.platform.startswith("win"):
        ps = shutil.which("powershell") or shutil.which("pwsh")
        return Availability(bool(ps), "powershell", "" if ps else "PowerShell not found")
    if not _has_display():
        return Availability(False, reason="No desktop session (DISPLAY / WAYLAND_DISPLAY not set), e.g. Docker or SSH")
    for tool in ("zenity", "kdialog", "yad"):
        if shutil.which(tool):
            return Availability(True, tool)
    if _tk_available():
        return Availability(True, "tk")
    return Availability(False, reason="Install zenity or kdialog to use the system folder dialog")


def _command(method: str, start: str) -> list[str]:
    if method == "osascript":
        script = f'POSIX path of (choose folder with prompt "{PROMPT}" default location (POSIX file "{start}"))'
        return ["osascript", "-e", script]
    if method == "powershell":
        exe = shutil.which("powershell") or shutil.which("pwsh") or "powershell"
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false};"
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;"
            f"$d.Description = '{PROMPT}'; $d.UseDescriptionForTitle = $true; $d.ShowNewFolderButton = $true;"
            f"$d.SelectedPath = '{start}';"
            "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"
        )
        return [exe, "-NoProfile", "-STA", "-Command", ps]
    if method == "zenity":
        return ["zenity", "--file-selection", "--directory", f"--title={PROMPT}", f"--filename={start.rstrip('/')}/"]
    if method == "kdialog":
        return ["kdialog", "--getexistingdirectory", start, "--title", PROMPT]
    if method == "yad":
        return ["yad", "--file", "--directory", f"--title={PROMPT}", f"--filename={start.rstrip('/')}/"]
    # tk fallback in a child process (Tk must own the main thread)
    code = (
        "import tkinter as tk, tkinter.filedialog as fd, sys;"
        "r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True);"
        f"p = fd.askdirectory(title={PROMPT!r}, initialdir={start!r}, mustexist=False);"
        "sys.stdout.write(p or '')"
    )
    return [sys.executable, "-c", code]


def _result(returncode: int, out: bytes, err: bytes) -> Path | None:
    path = out.decode("utf-8", "replace").strip()
    if returncode != 0 or not path:
        msg = err.decode("utf-8", "replace").strip()
        # every tool exits non-zero on Cancel (osascript: "User canceled. (-128)")
        if returncode in (1, 255) or "-128" in msg or not msg:
            return None
        raise DialogError(msg[:300])
    p = Path(path).expanduser()
    p.mkdir(parents=True, exist_ok=True)  # Tk may return a new folder name that doesn't exist yet
    return p.resolve()


def pick_directory_sync(start: str | None = None, *, enabled: bool = True) -> Path | None:
    """Blocking variant (used by the laptop-side helper)."""
    av = availability(enabled)
    if not av.available:
        raise DialogError(av.reason or "The system folder dialog is not available")
    start_dir = start if start and Path(start).is_dir() else str(Path.home())
    try:
        res = subprocess.run(_command(av.method, start_dir), capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None
    return _result(res.returncode, res.stdout, res.stderr)


async def pick_directory(start: str | None = None) -> Path | None:
    """Show the dialog and wait for the user. Returns the chosen folder, or ``None`` if they cancelled."""
    av = availability()
    if not av.available:
        raise DialogError(av.reason or "The system folder dialog is not available")
    start_dir = start if start and Path(start).is_dir() else str(Path.home())
    proc = await asyncio.create_subprocess_exec(*_command(av.method, start_dir), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        return None
    return _result(proc.returncode or 0, out, err)
