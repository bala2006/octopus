"""Native "choose folder" dialog, shown by the local backend on the user's own desktop.

Octopus runs on the user's machine, so the backend can open the operating system's folder picker (the browser can't
reveal real paths). Every picker used here lets the user create a new folder too:

* macOS   — ``osascript`` (``choose folder``)
* Windows — PowerShell and the Explorer-style ``IFileOpenDialog`` in folder mode
* Linux   — ``zenity``, ``kdialog`` or ``yad``; falls back to Tk's ``askdirectory``

When no desktop is available (SSH, CI) :func:`availability` says so, and the UI falls back to its built-in folder browser.
"""
from __future__ import annotations

import asyncio
import base64
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PROMPT = "Select Project Root"
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
        from app.foundation.config import get_settings  # lazy: the laptop-side helper has no backend dependencies

        enabled = get_settings().native_dialogs
    if not enabled:
        return Availability(False, reason="Native dialogs are disabled (NATIVE_DIALOGS=false)")
    if sys.platform == "darwin":
        return Availability(bool(shutil.which("osascript")), "osascript", "" if shutil.which("osascript") else "osascript not found")
    if sys.platform.startswith("win"):
        ps = shutil.which("powershell") or shutil.which("pwsh")
        return Availability(bool(ps), "powershell", "" if ps else "PowerShell not found")
    if not _has_display():
        return Availability(False, reason="No desktop session (DISPLAY / WAYLAND_DISPLAY not set), e.g. SSH or CI")
    for tool in ("zenity", "kdialog", "yad"):
        if shutil.which(tool):
            return Availability(True, tool)
    if _tk_available():
        return Availability(True, "tk")
    return Availability(False, reason="Install zenity or kdialog to use the system folder dialog")


def _foreground_window_handle() -> int | None:
    """Return Octopus's browser window so the system picker stays above the app."""
    if not sys.platform.startswith("win"):
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        get_foreground_window = user32.GetForegroundWindow
        get_foreground_window.restype = wintypes.HWND
        get_window_text_length = user32.GetWindowTextLengthW
        get_window_text_length.argtypes = [wintypes.HWND]
        get_window_text_length.restype = ctypes.c_int
        get_window_text = user32.GetWindowTextW
        get_window_text.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        get_window_class = user32.GetClassNameW
        get_window_class.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        is_window_visible = user32.IsWindowVisible
        is_window_visible.argtypes = [wintypes.HWND]
        foreground = int(get_foreground_window() or 0)

        def is_octopus_browser(hwnd: int) -> bool:
            if not is_window_visible(hwnd):
                return False
            title = ctypes.create_unicode_buffer(max(512, get_window_text_length(hwnd) + 1))
            get_window_text(hwnd, title, len(title))
            if "octopus" not in title.value.casefold():
                return False
            class_name = ctypes.create_unicode_buffer(128)
            get_window_class(hwnd, class_name, len(class_name))
            return "Chrome_WidgetWin" in class_name.value or class_name.value == "MozillaWindowClass"

        if foreground and is_octopus_browser(foreground):
            return foreground

        candidates: list[int] = []
        enum_proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

        def visit_window(hwnd: int, _lparam: int) -> bool:
            if is_octopus_browser(hwnd):
                candidates.append(int(hwnd))
                return False
            return True

        enum_windows = user32.EnumWindows
        enum_windows.argtypes = [enum_proc_type, wintypes.LPARAM]
        enum_windows.restype = wintypes.BOOL
        enum_windows(enum_proc_type(visit_window), 0)
        return candidates[0] if candidates else foreground or None
    except Exception:
        return None


def _command(method: str, start: str, owner: int | None = None) -> list[str]:
    if method == "osascript":
        script = f'POSIX path of (choose folder with prompt "{PROMPT}" default location (POSIX file "{start}"))'
        return ["osascript", "-e", script]
    if method == "powershell":
        exe = shutil.which("powershell") or shutil.which("pwsh") or "powershell"
        start_b64 = base64.b64encode(start.encode("utf-8")).decode("ascii")
        owner_b64 = base64.b64encode(str(owner or 0).encode("ascii")).decode("ascii")
        ps = r"""
try {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOctopusShellItem
{
    [PreserveSig] int BindToHandler(IntPtr bindContext, IntPtr handlerId, ref Guid interfaceId, out IntPtr result);
    [PreserveSig] int GetParent(out IOctopusShellItem parent);
    [PreserveSig] int GetDisplayName(uint displayNameType, out IntPtr displayName);
    [PreserveSig] int GetAttributes(uint mask, out uint attributes);
    [PreserveSig] int Compare(IOctopusShellItem other, uint hint, out int order);
}

[ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOctopusFileOpenDialog
{
    [PreserveSig] int Show(IntPtr owner);
    [PreserveSig] int SetFileTypes(uint count, IntPtr filters);
    [PreserveSig] int SetFileTypeIndex(uint index);
    [PreserveSig] int GetFileTypeIndex(out uint index);
    [PreserveSig] int Advise(IntPtr events, out uint cookie);
    [PreserveSig] int Unadvise(uint cookie);
    [PreserveSig] int SetOptions(uint options);
    [PreserveSig] int GetOptions(out uint options);
    [PreserveSig] int SetDefaultFolder(IOctopusShellItem folder);
    [PreserveSig] int SetFolder(IOctopusShellItem folder);
    [PreserveSig] int GetFolder(out IOctopusShellItem folder);
    [PreserveSig] int GetCurrentSelection(out IOctopusShellItem item);
    [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    [PreserveSig] int GetFileName(out IntPtr name);
    [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    [PreserveSig] int GetResult(out IOctopusShellItem item);
    [PreserveSig] int AddPlace(IOctopusShellItem item, uint alignment);
    [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    [PreserveSig] int Close(int result);
    [PreserveSig] int SetClientGuid(ref Guid guid);
    [PreserveSig] int ClearClientData();
    [PreserveSig] int SetFilter(IntPtr filter);
    [PreserveSig] int GetResults(out IntPtr items);
    [PreserveSig] int GetSelectedItems(out IntPtr items);
}

public static class OctopusNativeFolderPicker
{
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_DONTADDTORECENT = 0x02000000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);
    private static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
    private static readonly Guid IID_ShellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid interfaceId,
        out IOctopusShellItem item);

    private static void Check(int hresult)
    {
        if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
    }

    public static string Pick(string start, string title, IntPtr owner)
    {
        Type dialogClass = Type.GetTypeFromCLSID(CLSID_FileOpenDialog, true);
        IOctopusFileOpenDialog dialog = (IOctopusFileOpenDialog)Activator.CreateInstance(dialogClass);
        IOctopusShellItem startItem = null;
        IOctopusShellItem selectedItem = null;
        try
        {
            uint options;
            Check(dialog.GetOptions(out options));
            Check(dialog.SetOptions(options | FOS_NOCHANGEDIR | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_DONTADDTORECENT));
            Check(dialog.SetTitle(title));
            Check(dialog.SetOkButtonLabel("Select Folder"));
            Check(dialog.SetFileNameLabel("Folder:"));

            if (!String.IsNullOrWhiteSpace(start))
            {
                Guid shellItemId = IID_ShellItem;
                int hr = SHCreateItemFromParsingName(start, IntPtr.Zero, ref shellItemId, out startItem);
                if (hr >= 0) Check(dialog.SetFolder(startItem));
            }

            int showResult = dialog.Show(owner);
            if (showResult == ERROR_CANCELLED) return null;
            Check(showResult);
            Check(dialog.GetResult(out selectedItem));
            IntPtr displayName;
            Check(selectedItem.GetDisplayName(SIGDN_FILESYSPATH, out displayName));
            try { return Marshal.PtrToStringUni(displayName); }
            finally { Marshal.FreeCoTaskMem(displayName); }
        }
        finally
        {
            if (selectedItem != null) Marshal.ReleaseComObject(selectedItem);
            if (startItem != null) Marshal.ReleaseComObject(startItem);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }
}
'@
$start = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__START_B64__'))
$ownerValue = [Text.Encoding]::ASCII.GetString([Convert]::FromBase64String('__OWNER_B64__'))
$owner = [IntPtr]([long]::Parse($ownerValue))
$path = [OctopusNativeFolderPicker]::Pick($start, '__PROMPT__', $owner)
if ($path) { [Console]::Out.Write($path) }
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 2
}
""".replace("__START_B64__", start_b64).replace("__OWNER_B64__", owner_b64).replace("__PROMPT__", PROMPT)
        encoded_ps = base64.b64encode(ps.encode("utf-16le")).decode("ascii")
        return [exe, "-NoProfile", "-STA", "-EncodedCommand", encoded_ps]
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
        res = subprocess.run(_command(av.method, start_dir, _foreground_window_handle()), capture_output=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None
    return _result(res.returncode, res.stdout, res.stderr)


async def pick_directory(start: str | None = None) -> Path | None:
    """Show the dialog and wait for the user. Returns the chosen folder, or ``None`` if they cancelled."""
    av = availability()
    if not av.available:
        raise DialogError(av.reason or "The system folder dialog is not available")
    start_dir = start if start and Path(start).is_dir() else str(Path.home())
    proc = await asyncio.create_subprocess_exec(*_command(av.method, start_dir, _foreground_window_handle()), stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        return None
    return _result(proc.returncode or 0, out, err)
