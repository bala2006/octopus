/** The read-only specialists: the check-only shell, the project snapshot that undoes what a check changed, and their toolboxes. Real commands run in temporary folders. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkShellTool } from "../src/tools/commands";
import { specialistToolbox } from "../src/tools";
import { SPECIALISTS, SPECIALIST_DEFS } from "../src/engine/specialists";
import { ProjectFs } from "../src/safety/paths";
import { checkOnly } from "../src/safety/commands";
import { enterRound, leaveRound, restoreSnapshot, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_FILES, takeSnapshot } from "../src/workspace/snapshot";
import type { ToolContext } from "../src/tools/types";

const win = process.platform === "win32";
const [program, ...probeArgs] = win ? ["pwsh", "-NoProfile", "-Command", "exit 0"] : ["bash", "-c", "exit 0"];
const missing = spawnSync(program!, probeArgs, { encoding: "utf8" }).status !== 0;
if (missing) console.warn(`shell tests skipped: ${program} is not installed`);
const shellTest = missing ? test.skip : test;

/** A temporary project with the given files. Nothing here touches the repository. */
function project(files: Record<string, string> = {}): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), "specialists-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const ctx = {
    agent: { id: "specialist-1" }, task: null, runId: "run", fs: new ProjectFs(root), signal: new AbortController().signal,
    db: {}, seen: new Map(), shown: new Map(), answering: null, setStatus() {}, emit() {}, recordFile() {},
    ownerOf: () => null, guard: async () => { throw new Error("A check-only command never asks for approval"); },
  } as unknown as ToolContext;
  return { root, ctx };
}

const runCheck = (ctx: ToolContext, command: string) => checkShellTool.run(ctx, checkShellTool.args.parse({ command }), "call-1");

describe("check-only policy", () => {
  test.each([
    ["npx prettier --write .", "write-flag"],
    ["npm test -- -u", "write-flag"],
    ["echo x > a.txt", "redirect"],
    ["npm install left-pad", "install"],
    ["git commit -m done", "git-change"],
    ["node -e \"require('fs').writeFileSync('a', '')\"", "inline-code"],
    ["curl -o out.html https://example.com", "write-flag"],
    ["npm run deploy", "not-allowed"],
  ])("refuses %s and names rule %s", (command, rule) => {
    const verdict = checkOnly(command, process.cwd());
    expect(verdict).toMatchObject({ allowed: false, rule });
  });

  test.each(["npm test", "npm run typecheck", "git status", "git diff --stat", "node check.mjs", "curl https://example.com", "npm test 2>&1 | Select-Object -Last 5"])(
    "allows %s", (command) => {
      expect(checkOnly(command, process.cwd())).toEqual({ allowed: true });
    });
});

describe("check-only shell", () => {
  shellTest("a refused command never runs, and the result names the rule", async () => {
    const { root, ctx } = project({ "src.txt": "kept" });
    const res = await runCheck(ctx, "echo x > a.txt");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("rule redirect");
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  shellTest("git status and npm test run for real in the project", async () => {
    const { root, ctx } = project({
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node check.mjs" } }),
      "check.mjs": "console.log('checks passed');\n",
    });
    spawnSync("git", ["init", "-q"], { cwd: root });
    const status = await runCheck(ctx, "git status --short");
    expect(status.ok).toBe(true);
    expect(status.text.endsWith("[exit code: 0]")).toBe(true);
    const tests = await runCheck(ctx, "npm test");
    expect(tests.ok).toBe(true);
    expect(tests.text).toContain("checks passed");
    expect(tests.text.endsWith("[exit code: 0]")).toBe(true);
  }, 60_000);
});

describe("project snapshot", () => {
  shellTest("a check that rewrites a file and adds one is undone", async () => {
    const { root, ctx } = project({
      "src.txt": "before",
      "change.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('src.txt', 'after');\nwriteFileSync('new.txt', 'made by the check');\n",
    });
    const snap = takeSnapshot(root);
    const res = await runCheck(ctx, "node change.mjs");
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(root, "src.txt"), "utf8")).toBe("after");
    const report = restoreSnapshot(root, snap);
    expect(report.restored).toEqual(["src.txt"]);
    expect(report.deleted).toEqual(["new.txt"]);
    expect(readFileSync(path.join(root, "src.txt"), "utf8")).toBe("before");
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  test("files over 1 MB and ignored folders are not recorded", () => {
    const { root } = project({ "small.txt": "a", "big.bin": "x".repeat(SNAPSHOT_MAX_BYTES + 1), "node_modules/pkg/index.js": "module" });
    const snap = takeSnapshot(root);
    expect([...snap.files.keys()]).toEqual(["small.txt"]);
    expect(snap.partial).toBe(false);
  });

  test("a folder with more files than the record holds never has new files deleted", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= SNAPSHOT_MAX_FILES; i++) files[`f${i}.txt`] = "x";
    const { root } = project(files);
    const snap = takeSnapshot(root);
    expect(snap.partial).toBe(true);
    expect(snap.files.size).toBe(SNAPSHOT_MAX_FILES);
    writeFileSync(path.join(root, "extra.txt"), "made later");
    const report = restoreSnapshot(root, snap);
    expect(report.deleted).toEqual([]);
    expect(existsSync(path.join(root, "extra.txt"))).toBe(true);
  }, 60_000);

  test("overlapping rounds share one record, and the last one to end restores", () => {
    const { root } = project({ "a.txt": "original" });
    enterRound(root);
    enterRound(root);
    writeFileSync(path.join(root, "a.txt"), "changed");
    expect(leaveRound(root)).toBeNull();
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("changed");
    const report = leaveRound(root);
    expect(report?.restored).toEqual(["a.txt"]);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
  });
});

/** Tools that change state, remember things or ask the user. No specialist may hold one. */
const WRITE_TOOLS = ["write_file", "edit_file", "move_file", "delete_file", "remember", "forget", "ask_user", "todo_write", "message", "reply", "pin", "complete_task", "block_task", "submit_acceptance", "start_work", "hire_agent"];

describe("specialist definitions", () => {
  test.each(SPECIALISTS)("%s has its prompt and skill, under 4,000 characters together", (name) => {
    const def = SPECIALIST_DEFS[name];
    expect(def.instructions.length).toBeLessThan(4_000);
    expect(def.instructions).toContain("\n\n");
    expect(def.instructions.startsWith(readFileSync(path.join(process.cwd(), "src", "catalog", "specialists", name, "prompt.md"), "utf8").trim())).toBe(true);
  });

  test("each specialist has the effort the plan sets", () => {
    expect(Object.fromEntries(SPECIALISTS.map((n) => [n, SPECIALIST_DEFS[n].effort]))).toEqual({ reviewer: "medium", security: "high", designer: "high", explorer: "low" });
  });

  test("the explorer ends with a plain text answer, and no prompt names a tool its toolbox lacks", () => {
    expect(SPECIALIST_DEFS.explorer.ends).toBe("answer");
    expect(SPECIALIST_DEFS.explorer.tools).not.toContain("submit_review");
    const outside = ["fetch_url", "start_dev_server", "submit_review", "write_file", "edit_file", "delete_file", "ask_user", "todo_write", "remember"];
    for (const name of SPECIALISTS) {
      const def = SPECIALIST_DEFS[name];
      for (const tool of outside) {
        if ((def.tools as readonly string[]).includes(tool)) continue;
        expect(new RegExp(`\\b${tool}\\b`).test(def.instructions), `${name} names ${tool}`).toBe(false);
      }
    }
  });
});

describe("specialist toolboxes", () => {
  test.each(SPECIALISTS)("%s gets its listed tools, the check-only shell, and no write tool", async (name) => {
    const { root } = project();
    const { tools } = await specialistToolbox(SPECIALIST_DEFS[name].tools, root);
    const names = tools.map((t) => t.name);
    for (const forbidden of WRITE_TOOLS) expect(names).not.toContain(forbidden);
    expect(names).toEqual(expect.arrayContaining(["read_file", "glob", "grep", "shell"]));
    expect(tools.find((t) => t.name === "shell")).toBe(checkShellTool);
  });

  test("the reviewer, security and designer end with submit_review, and the explorer has none", async () => {
    const { root } = project();
    const named = async (name: (typeof SPECIALISTS)[number]) => (await specialistToolbox(SPECIALIST_DEFS[name].tools, root)).tools.map((t) => t.name);
    expect(await named("reviewer")).toContain("submit_review");
    expect(await named("security")).toEqual(expect.arrayContaining(["submit_review", "fetch_url"]));
    expect(await named("designer")).toEqual(expect.arrayContaining(["submit_review", "start_dev_server"]));
    expect(await named("explorer")).not.toContain("submit_review");
    expect(await named("reviewer")).not.toContain("fetch_url");
  });

  test("the designer's browser is missing when the browser is off, and the toolbox says why", async () => {
    const { root } = project();
    const { tools, warnings } = await specialistToolbox(SPECIALIST_DEFS.designer.tools, root);
    expect(tools.some((t) => t.name.startsWith("browser_"))).toBe(false);
    expect(warnings.some((w) => w.startsWith("Browser unavailable"))).toBe(true);
  });
});