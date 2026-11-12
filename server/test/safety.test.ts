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
  // runners and wrappers are judged by the command they run
  ["uv run rm -rf .", "deny"], ["poetry run rm -rf .", "deny"], ["bundle exec rm -rf .", "deny"], ["timeout 5 rm -rf .", "deny"], ["nice rm -rf .", "deny"],
  ["uv run pytest -q", "low"], ["timeout 60 npm test", "low"], ["nice -n 10 npm test", "low"], ["pnpm dlx create-x", "medium"],
  // inline code and scriptable editors
  ["node -pe 1", "medium"], ["python3 -Ic 1", "medium"], ["deno eval 1", "medium"], ["sed -n e x", "medium"], ["awk 1 a", "medium"],
  // paths glued to flags, sibling folders, secrets
  ["cat ../proj-secrets/a", "deny"], ["gcc -o../x a.c", "deny"], ["cat .env", "high"], ["cat .env.example", "low"], ["ls .GIT", "deny"],
])("%s is %s", (cmd, expected) => expect(risk(cmd)).toBe(expected));

test("paths stay inside the project and out of Git and Octopus internals", () => {
  const fs = new ProjectFs(root);
  expect(fs.rel("src/../src/a.ts")).toBe("src/a.ts");
  expect(fs.rel(".octopus/work/notes.md")).toBe(".octopus/work/notes.md");
  for (const bad of ["../x", "/etc/passwd", "C:\\x", ".git/config", ".octopus/octopus.db"]) expect(() => fs.rel(bad)).toThrow();
  expect(() => fs.rel(".octopus/work/a", "user")).toThrow();
  expect(() => fs.rel(".GIT/hooks/pre-commit")).toThrow();
  expect(() => fs.rel(".Octopus/work/x")).toThrow();
  symlinkSync("/", path.join(root, "escape"));
  expect(() => fs.abs("escape/etc/passwd")).toThrow(/outside/);
  symlinkSync(path.join(path.dirname(root), "not-there-yet"), path.join(root, "dangling"));
  expect(() => fs.abs("dangling")).toThrow(/outside/);
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
