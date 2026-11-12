#!/usr/bin/env node
/**
 * The launcher: `npm start` builds the web app when it is out of date and serves everything on one address;
 * `npm run dev` runs the web app with hot reload on that address and the server on the next port, with restarts.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.OCTOPUS_PORT ?? 8000);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error(`Octopus needs Node 22.22 or newer (found ${process.versions.node}).`);
  process.exit(1);
}
if (!existsSync(path.join(root, "node_modules"))) {
  console.error("Dependencies are missing. Run `npm install` first.");
  process.exit(1);
}

const children = [];
function run(args, env = {}) {
  const child = spawn(npm, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" });
  children.push(child);
  child.on("exit", (code) => { if (code && code !== 0) shutdown(code); });
  return child;
}
function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function newest(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

const mode = process.argv[2] ?? "start";
if (mode === "dev") {
  const api = port + 1;
  run(["run", "dev", "-w", "@octopus/server"], { OCTOPUS_API_PORT: String(api), OCTOPUS_PORT: String(port) });
  run(["run", "dev", "-w", "@octopus/web"], { OCTOPUS_PORT: String(port), OCTOPUS_API: `http://127.0.0.1:${api}` });
} else if (mode === "start") {
  const dist = path.join(root, "web", "dist", "index.html");
  const stale = !existsSync(dist) || Math.max(newest(path.join(root, "web", "src")), newest(path.join(root, "shared", "src"))) > statSync(dist).mtimeMs;
  if (stale && process.env.OCTOPUS_SKIP_BUILD !== "true") {
    console.log("Building the web app…");
    const build = run(["run", "build", "-w", "@octopus/web"]);
    build.on("exit", (code) => { if (code === 0) run(["start", "-w", "@octopus/server"], { OCTOPUS_PORT: String(port) }); });
  } else {
    run(["start", "-w", "@octopus/server"], { OCTOPUS_PORT: String(port) });
  }
} else {
  console.error("Usage: node scripts/octopus.mjs [start|dev]");
  process.exit(1);
}
