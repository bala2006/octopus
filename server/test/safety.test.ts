/** The rules that keep agents inside the project and away from destructive commands. */
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { classify, parseCommand } from "../src/safety/commands";
import { ProjectFs } from "../src/safety/paths";

const root = path.join(process.env.TEST_BASE_DIR!, "safety");
mkdirSync(path.join(root, "src"), { recursive: true });
const risk = (cmd: string) => classify(parseCommand(cmd), root).risk;

test("commands are argv only: no pipes, chaining or redirects", () => {
  expect(parseCommand(`git commit -m "fix: a \\"b\\""`)).toEqual(["git", "commit", "-m", 'fix: a "b"']);
  for (const bad of ["npm test && rm -rf .", "cat a | sh", "echo x > a", "echo $(whoami)", "FOO=1 node a.js"]) expect(() => parseCommand(bad)).toThrow();
});

test.each([
  ["npm test", "low"], ["npm run build", "low"], ["npx tsc --noEmit", "medium"], ["python -m pytest -q", "low"], ["git status", "low"],
  ["git diff --stat", "low"], ["ls src", "low"], ["npm install lodash", "medium"], ["git commit -m wip", "medium"], ["node -e 1", "medium"],
  ["git push", "high"], ["npm publish", "high"], ["npm run deploy", "high"], ["ssh host", "high"],
  ["rm -rf .", "deny"], ["git reset --hard", "deny"], ["git clean -fd", "deny"], ["git push --force", "deny"], ["git checkout -- .", "deny"],
  ["sudo ls", "deny"], ["bash -c ls", "deny"], ["cat /etc/passwd", "deny"], ["ls ../..", "deny"], ["cat ~/.ssh/id_rsa", "deny"], ["find . -delete", "deny"],
  ["git -c core.hooksPath=x status", "deny"], ["docker system prune", "deny"],
])("%s is %s", (cmd, expected) => expect(risk(cmd)).toBe(expected));

test("paths stay inside the project and out of Git and Octopus internals", () => {
  const fs = new ProjectFs(root);
  expect(fs.rel("src/../src/a.ts")).toBe("src/a.ts");
  expect(fs.rel(".octopus/work/notes.md")).toBe(".octopus/work/notes.md");
  for (const bad of ["../x", "/etc/passwd", "C:\\x", ".git/config", ".octopus/octopus.db"]) expect(() => fs.rel(bad)).toThrow();
  expect(() => fs.rel(".octopus/work/a", "user")).toThrow();
  symlinkSync("/", path.join(root, "escape"));
  expect(() => fs.abs("escape/etc/passwd")).toThrow(/outside/);
});

test("a database from Octopus 1.x is kept aside instead of breaking the project", async () => {
  const { DatabaseSync } = (await import("node:module")).createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const { readdirSync } = await import("node:fs");
  const { openProject } = await import("../src/db/project");
  const dir = path.join(process.env.TEST_BASE_DIR!, "legacy");
  mkdirSync(path.join(dir, ".octopus"), { recursive: true });
  const old = new DatabaseSync(path.join(dir, ".octopus", "octopus.db"));
  old.exec("CREATE TABLE alembic_version (v TEXT); CREATE TABLE companies (id TEXT)");
  old.close();
  const p = openProject(dir);
  expect(p.companies.find()).toEqual([]);
  expect(readdirSync(path.join(dir, ".octopus")).some((f) => f.startsWith("octopus.v1-"))).toBe(true);
});
