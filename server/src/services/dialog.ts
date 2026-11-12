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

function command(m: string, start: string): string[] {
  switch (m) {
    case "osascript": return ["osascript", "-e", `POSIX path of (choose folder with prompt "${PROMPT}" default location (POSIX file "${start}"))`];
    case "powershell": return ["powershell", "-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; " +
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{Description='${PROMPT}'; UseDescriptionForTitle=$true; ShowNewFolderButton=$true; SelectedPath='${start.replace(/'/g, "''")}'}; ` +
      "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }"];
    case "zenity": return ["zenity", "--file-selection", "--directory", `--title=${PROMPT}`, `--filename=${start}/`];
    case "kdialog": return ["kdialog", "--getexistingdirectory", start, "--title", PROMPT];
    default: return ["yad", "--file", "--directory", `--title=${PROMPT}`, `--filename=${start}/`];
  }
}

/** Show the dialog and return the chosen folder, or null when cancelled. */
export async function pickDirectory(start = homedir()): Promise<string | null> {
  const a = availability();
  if (!a.available || !a.method) throw new Error(a.reason ?? "No folder dialog available");
  const res = await run(command(a.method, start), { cwd: homedir(), env: process.env, timeoutMs: 10 * 60_000 });
  const out = res.output.trim().split("\n").pop()?.trim() ?? "";
  return res.code === 0 && out ? out.replace(/\/$/, "") || "/" : null;
}
