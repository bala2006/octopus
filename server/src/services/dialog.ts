/**
 * The operating system's "choose folder" dialog, shown by the local server on your desktop (the browser cannot reveal
 * real paths). Without a desktop session the web app falls back to its own folder browser.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import type { NativeDialogOut } from "@octopus/shared";
import { config } from "../config";
import { run } from "../lib/proc";

const PROMPT = "Choose a project folder for Octopus";
const has = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;

function method(): NativeDialogOut {
  if (!config.nativeDialogs) return { available: false, reason: "Disabled (NATIVE_DIALOGS=false)" };
  if (process.platform === "darwin") return has("osascript") ? { available: true, method: "osascript" } : { available: false, reason: "osascript not found" };
  if (process.platform === "win32") return { available: true, method: "powershell" };
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { available: false, reason: "No desktop session (DISPLAY / WAYLAND_DISPLAY not set)" };
  for (const tool of ["zenity", "kdialog", "yad"]) if (has(tool)) return { available: true, method: tool };
  return { available: false, reason: "Install zenity or kdialog to use the system folder dialog" };
}

let cached: NativeDialogOut | null = null;
export const availability = () => (cached ??= method());

/**
 * The Windows folder dialog, in the Explorer style of the file dialogs. The server is a background process, so Windows
 * opens its dialog behind the browser. A helper thread makes that dialog topmost. The script is sent base64-encoded so
 * its quotes survive cmd.exe.
 */
function folderScript(start: string): string {
  const q = (s: string) => s.replace(/'/g, "''");
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    `Add-Type -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title); [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); public static void MakeTopmost(string title) { var t = new System.Threading.Thread(() => { for (int i = 0; i < 400; i++) { IntPtr h = FindWindow(\"#32770\", title); if (h != IntPtr.Zero) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0003); return; } System.Threading.Thread.Sleep(50); } }); t.IsBackground = true; t.Start(); }' -Name Fg -Namespace Octo`,
    `[Octo.Fg]::MakeTopmost('${PROMPT}')`,
    `$d = New-Object System.Windows.Forms.OpenFileDialog -Property @{Title='${PROMPT}'; FileName='Folder Selection.'; ValidateNames=$false; CheckFileExists=$false; InitialDirectory='${q(start)}'}`,
    "if ($d.ShowDialog() -eq 'OK') { $p = $d.FileName; if (-not (Test-Path -LiteralPath $p -PathType Container)) { $p = [System.IO.Path]::GetDirectoryName($p) }; [Console]::Out.WriteLine('OCTOPUS_PICK:' + $p) }",
  ].join("; ");
}

function command(m: string, start: string): string[] {
  switch (m) {
    case "osascript": return ["osascript", "-e", `POSIX path of (choose folder with prompt "${PROMPT}" default location (POSIX file "${start}"))`];
    case "powershell": return ["powershell", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(folderScript(start), "utf16le").toString("base64")];
    case "zenity": return ["zenity", "--file-selection", "--directory", `--title=${PROMPT}`, `--filename=${start}/`];
    case "kdialog": return ["kdialog", "--getexistingdirectory", start, "--title", PROMPT];
    default: return ["yad", "--file", "--directory", `--title=${PROMPT}`, `--filename=${start}/`];
  }
}

/**
 * The folder a dialog returned, or null when it was cancelled. The Windows script marks its answer, because its helper
 * can print other lines, and a failed run is an error. The other tools print only the path, and exit non-zero when
 * the user cancels.
 */
export function pickedFolder(m: string, code: number | null, output: string): string | null {
  if (m === "powershell") {
    if (code !== 0) throw new Error(`The folder dialog failed (exit ${code}): ${output.trim()}`);
    const picked = /^OCTOPUS_PICK:(.+)$/m.exec(output)?.[1]?.trim();
    return picked ? picked.replace(/\/$/, "") || "/" : null;
  }
  const out = output.trim().split("\n").pop()?.trim() ?? "";
  return code === 0 && out ? out.replace(/\/$/, "") || "/" : null;
}

/** Show the dialog and return the chosen folder, or null when cancelled. */
export async function pickDirectory(start = homedir()): Promise<string | null> {
  const a = availability();
  if (!a.available || !a.method) throw new Error(a.reason ?? "No folder dialog available");
  const res = await run(command(a.method, start), { cwd: homedir(), env: process.env, timeoutMs: 10 * 60_000 });
  return pickedFolder(a.method, res.code, res.output);
}
