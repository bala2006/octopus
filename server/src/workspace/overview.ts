/**
 * What a project is: its layout, stack, scripts and how to check it. Feeds the agents' context, the automatic
 * verification after changes, and the workspace's task list.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectTask } from "@octopus/shared";
import { parseJson } from "../lib/util";
import type { ProjectFs } from "../safety/paths";

type Pkg = { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const readText = (root: string, rel: string) => { try { return readFileSync(path.join(root, rel), "utf8"); } catch { return ""; } };

function packageManager(root: string, dir: string): string {
  const at = (f: string) => existsSync(path.join(root, dir, f)) || existsSync(path.join(root, f));
  return at("pnpm-lock.yaml") ? "pnpm" : at("yarn.lock") ? "yarn" : at("bun.lockb") || at("bun.lock") ? "bun" : "npm";
}

/** Runnable project tasks: package.json scripts (root and one level down), Python, Go, Rust and Make targets. */
export function projectTasks(fs: ProjectFs): ProjectTask[] {
  const tasks: ProjectTask[] = [];
  const dirs = ["", ...fs.walk({ max: 3000 }).files.filter((f) => /^[^/]+\/package\.json$/.test(f)).map((f) => path.posix.dirname(f))];
  for (const dir of dirs) {
    const pkg = parseJson<Pkg>(readText(fs.root, path.posix.join(dir, "package.json")), {});
    const pm = packageManager(fs.root, dir);
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      if (name === "test" && /no test specified/.test(script)) continue;
      const server = /^(dev|start|serve|preview)$/.test(name) || /\b(vite|next dev|nodemon|serve|http-server|webpack serve)\b/.test(script) && !/build/.test(name);
      tasks.push({ id: `${dir || "."}:${name}`, name: dir ? `${dir}: ${name}` : name, command: `${pm} run ${name}`, directory: dir || ".", kind: server ? "server" : "task", source: path.posix.join(dir, "package.json") });
    }
  }
  const has = (f: string) => existsSync(path.join(fs.root, f));
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("tests") && fs.walk({ base: "tests", max: 200 }).files.some((f) => f.endsWith(".py")))
    tasks.push({ id: "python:test", name: "pytest", command: "python -m pytest -q", directory: ".", kind: "task", source: "python" });
  if (has("manage.py")) tasks.push({ id: "django:run", name: "Django server", command: "python manage.py runserver", directory: ".", kind: "server", source: "manage.py" });
  if (has("go.mod")) tasks.push({ id: "go:test", name: "go test", command: "go test ./...", directory: ".", kind: "task", source: "go.mod" });
  if (has("Cargo.toml")) tasks.push({ id: "cargo:test", name: "cargo test", command: "cargo test", directory: ".", kind: "task", source: "Cargo.toml" });
  if (has("Makefile")) for (const m of readText(fs.root, "Makefile").matchAll(/^([a-zA-Z][\w-]*):/gm)) tasks.push({ id: `make:${m[1]}`, name: `make ${m[1]}`, command: `make ${m[1]}`, directory: ".", kind: "task", source: "Makefile" });
  return tasks;
}

/** The checks run automatically after the team changes code: tests, type checks and lint, if the project has them. */
export function verificationChecks(fs: ProjectFs): ProjectTask[] {
  const tasks = projectTasks(fs).filter((t) => t.kind === "task");
  const pick = (re: RegExp) => tasks.filter((t) => re.test(t.id.split(":").pop() ?? ""));
  const checks = [...pick(/^test$/), ...pick(/^(typecheck|type-check|tsc|check-types)$/), ...pick(/^lint$/)];
  if (tasks.some((t) => t.id === "python:test")) checks.push(tasks.find((t) => t.id === "python:test")!);
  for (const id of ["go:test", "cargo:test"]) if (tasks.some((t) => t.id === id)) checks.push(tasks.find((t) => t.id === id)!);
  return checks.slice(0, 4);
}

/** A compact description of the project for agent prompts. */
export function projectOverview(fs: ProjectFs): string {
  const { files, truncated } = fs.walk({ max: 2000, actor: "agent" });
  if (!files.length) return "The project folder is empty: you are starting from scratch.";
  const top = new Map<string, number>();
  for (const f of files) { const k = f.includes("/") ? `${f.split("/")[0]}/` : f; top.set(k, (top.get(k) ?? 0) + 1); }
  const layout = [...top.entries()].slice(0, 60).map(([k, n]) => (k.endsWith("/") ? `${k} (${n} files)` : k)).join("\n");
  const pkg = parseJson<Pkg>(readText(fs.root, "package.json"), {});
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40).join(", ");
  const readme = readText(fs.root, files.find((f) => /^readme(\.md)?$/i.test(f)) ?? "").split("\n").slice(0, 40).join("\n");
  const tasks = projectTasks(fs).slice(0, 20).map((t) => `- ${t.name}: \`${t.command}\`${t.directory !== "." ? ` (in ${t.directory})` : ""}`).join("\n");
  return [
    `${files.length}${truncated ? "+" : ""} files. Top level:\n${layout}`,
    deps && `Dependencies: ${deps}`,
    tasks && `Scripts and checks:\n${tasks}`,
    readme && `README (start):\n${readme}`,
  ].filter(Boolean).join("\n\n");
}
