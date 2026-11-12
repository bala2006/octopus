/** Python virtual environments in the project that agent and workspace commands can run inside. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJson, UserError } from "../lib/util";

const file = (root: string) => path.join(root, ".octopus", "environment.json");

export function environments(root: string): { id: string; label: string; path: string }[] {
  return [".venv", "venv", "env"].flatMap((name) => {
    const exe = path.join(root, name, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    return existsSync(exe) ? [{ id: `venv:${name}`, label: `Python (${name})`, path: name }] : [];
  });
}

export function selectedEnvironment(root: string): string | null {
  const selected = parseJson<{ selected?: string | null }>(existsSync(file(root)) ? readFileSync(file(root), "utf8") : "", {}).selected ?? null;
  return environments(root).some((e) => e.id === selected) ? selected : null;
}

export function saveEnvironment(root: string, selected: string | null) {
  if (selected && !environments(root).some((e) => e.id === selected)) throw new UserError("That Python environment is no longer available. Refresh and choose again.");
  mkdirSync(path.dirname(file(root)), { recursive: true });
  writeFileSync(file(root), JSON.stringify({ selected }, null, 2));
}

/** Absolute path of the selected virtual environment, if any. */
export function environmentPath(root: string): string | null {
  const id = selectedEnvironment(root);
  const env = environments(root).find((e) => e.id === id);
  return env ? path.join(root, env.path) : null;
}
