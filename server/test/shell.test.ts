/** The shell tool runs the system shell in a temporary project. Each case skips, with the reason logged, when that shell is not installed. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandTools } from "../src/tools/commands";
import { ProjectFs, WORK_DIR } from "../src/safety/paths";
import type { Tool, ToolContext } from "../src/tools/types";

const win = process.platform === "win32";
const [program, ...probeArgs] = win ? ["pwsh", "-NoProfile", "-Command", "exit 0"] : ["bash", "-c", "exit 0"];
const missing = spawnSync(program!, probeArgs, { encoding: "utf8" }).status !== 0;
if (missing) console.warn(`shell tests skipped: ${program} is not installed`);
const shellTest = missing ? test.skip : test;

const shell: Tool = commandTools.find((t) => t.name === "shell")!;

function project(files: Record<string, string> = {}): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), "shell-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const ctx = {
    agent: { id: "agent-1" }, task: null, runId: "run", fs: new ProjectFs(root), signal: new AbortController().signal,
    db: {}, seen: new Map(), shown: new Map(), answering: null, setStatus() {}, emit() {}, recordFile() {},
    ownerOf: () => null, guard: async () => {},
  } as unknown as ToolContext;
  return { root, ctx };
}

const callShell = (ctx: ToolContext, args: Record<string, unknown>, callId = "call-1") => shell.run(ctx, shell.args.parse(args), callId);

shellTest("a pipeline runs in the real shell and the result ends with the exit code", async () => {
  const { ctx } = project();
  const command = win ? "Write-Output hi | Select-Object -First 1" : "echo hi | head -n 1";
  const res = await callShell(ctx, { command });
  expect(res.ok).toBe(true);
  const lines = res.text.split("\n");
  expect(lines.at(-2)).toBe("hi");
  expect(lines.at(-1)).toBe("[exit code: 0]");
});

shellTest("a failing command reports its non-zero exit code", async () => {
  const { ctx } = project();
  const res = await callShell(ctx, { command: "exit 3" });
  expect(res.ok).toBe(false);
  expect(res.text.endsWith("[exit code: 3]")).toBe(true);
});

shellTest("a command past timeout_s is stopped and the result says so", async () => {
  const { ctx } = project();
  const command = win ? "Start-Sleep -Seconds 30" : "sleep 30";
  const res = await callShell(ctx, { command, timeout_s: 2 });
  expect(res.ok).toBe(false);
  expect(res.text.endsWith("[timed out after 2s]")).toBe(true);
}, 20_000);

shellTest("a 100,000-character output is spilled, and the spill file holds all of it", async () => {
  const body = "a".repeat(100_000);
  const { root, ctx } = project({ "big.txt": `${body}\n` });
  const command = win ? "Get-Content big.txt" : "cat big.txt";
  const res = await callShell(ctx, { command }, "call-big");
  const spillPath = `${WORK_DIR}/spill/call-big.txt`;
  expect(res.ok).toBe(true);
  expect(res.text).toContain(`The full output is saved at ${spillPath}`);
  expect(res.text.startsWith(`$ ${command}\n${"a".repeat(20_000)}`)).toBe(true);
  expect(res.text.endsWith("[exit code: 0]")).toBe(true);
  expect(readFileSync(path.join(root, spillPath), "utf8")).toBe(body);
}, 60_000);

shellTest("a chain with Remove-Item is refused and deletes nothing", async () => {
  const { root, ctx } = project({ "src/a.ts": "export const a = 1;\n" });
  const res = await callShell(ctx, { command: "npm test; Remove-Item -Recurse src" });
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/^Refused: /);
  expect(existsSync(path.join(root, "src", "a.ts"))).toBe(true);
});

shellTest("a chain with rm -rf is refused and deletes nothing", async () => {
  const { root, ctx } = project({ "src/a.ts": "export const a = 1;\n" });
  const res = await callShell(ctx, { command: "npm test && rm -rf src" });
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/^Refused: /);
  expect(existsSync(path.join(root, "src", "a.ts"))).toBe(true);
});
