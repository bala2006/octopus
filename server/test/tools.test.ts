/** The file tools run against a real folder, with the engine's context reduced to the fields they touch. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileTools } from "../src/tools/files";
import { ProjectFs } from "../src/safety/paths";
import { todoTools } from "../src/tools/todo";
import { agentLoop } from "../src/engine/agent";
import { openRegistry } from "../src/db/registry";
import { encrypt } from "../src/lib/secrets";
import type { Item } from "../src/llm/azure";
import type { McpToolOut } from "@octopus/shared";
import { BUILDER_BROWSER_TOOLS, selectBrowserTools } from "../src/services/mcp";
import { defineTool, type Tool, type ToolContext } from "../src/tools/types";
import { z } from "zod";
import { fakeModel, type Script } from "./fakeModel";

function project(files: Record<string, string>): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), "tools-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const ctx = {
    agent: { id: "agent-1" }, task: null, runId: "run", fs: new ProjectFs(root), signal: new AbortController().signal,
    db: { artifacts: { count: () => 0 } }, seen: new Map(), shown: new Map(), answering: null,
    setStatus() {}, emit() {}, recordFile() {}, ownerOf: () => null, guard: async () => {},
  } as unknown as ToolContext;
  return { root, ctx };
}

/** Runs one file tool the way the agent loop does: the arguments pass the tool's schema first. */
async function run(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const tool: Tool = [...fileTools, ...todoTools].find((t) => t.name === name)!;
  return tool.run(ctx, tool.args.parse(args), "call");
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("read_file", () => {
  test("numbers each line and names the next offset when the file is longer than one read", async () => {
    const { ctx } = project({ "big.txt": numbered(3000) });
    const { text } = await run(ctx, "read_file", { path: "big.txt" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("1: line 1");
    expect(lines[1999]).toBe("2000: line 2000");
    expect(lines).toHaveLength(2001);
    expect(lines[2000]).toBe("(Showing lines 1-2000 of 3000. Use offset=2001 to continue.)");
  });

  test("offset and limit read a range, and the last lines end with the end-of-file footer", async () => {
    const { ctx } = project({ "big.txt": numbered(3000) });
    const window = await run(ctx, "read_file", { path: "big.txt", offset: 100, limit: 2 });
    expect(window.text).toBe("100: line 100\n101: line 101\n(Showing lines 100-101 of 3000. Use offset=102 to continue.)");
    const tail = await run(ctx, "read_file", { path: "big.txt", offset: 2990 });
    expect(tail.text.split("\n").slice(-2)).toEqual(["3000: line 3000", "(End of file - total 3000 lines)"]);
  });

  test("a 2,000-line file of long lines stops at the character budget and names the offset to continue", async () => {
    const { ctx } = project({ "long.txt": Array.from({ length: 2000 }, (_, i) => `${i}`.padEnd(100, "x")).join("\n") });
    const { text } = await run(ctx, "read_file", { path: "long.txt" });
    const lines = text.split("\n");
    const footer = lines.at(-1)!;
    const last = Number(footer.match(/^\(Output capped\. Showing lines 1-(\d+)\./)?.[1]);
    expect(text.length).toBeLessThan(30_000);
    expect(footer).toBe(`(Output capped. Showing lines 1-${last}. Use offset=${last + 1} to continue.)`);
    expect(lines).toHaveLength(last + 1);
    expect(lines[last - 1]!.startsWith(`${last}: `)).toBe(true);
    const next = await run(ctx, "read_file", { path: "long.txt", offset: last + 1 });
    expect(next.text.startsWith(`${last + 1}: `)).toBe(true);
  });

  test("a limit above 2000 lines is refused by the schema", () => {
    const tool = fileTools.find((t) => t.name === "read_file")!;
    expect(() => tool.args.parse({ path: "big.txt", limit: 2001 })).toThrow();
  });

  test("an offset past the end says how many lines the file has", async () => {
    const { ctx } = project({ "big.txt": numbered(3) });
    const r = await run(ctx, "read_file", { path: "big.txt", offset: 5 });
    expect(r).toEqual({ text: "offset 5 is out of range for big.txt (3 lines).", ok: false });
  });

  test("a line longer than 2000 characters is cut and says so", async () => {
    const { ctx } = project({ "wide.txt": `${"x".repeat(2500)}\nshort` });
    const { text } = await run(ctx, "read_file", { path: "wide.txt" });
    expect(text.split("\n")[0]).toBe(`1: ${"x".repeat(2000)}... (line truncated to 2000 chars)`);
    expect(text.split("\n")[1]).toBe("2: short");
  });

  test("a second read of lines already in the transcript costs one line", async () => {
    const { ctx } = project({ "big.txt": numbered(30) });
    await run(ctx, "read_file", { path: "big.txt" });
    const again = await run(ctx, "read_file", { path: "big.txt" });
    expect(again.text).toMatch(/lines 1-30 have not changed since you read them/);
  });
});

describe("glob", () => {
  test("lists paths newest first and caps the list at 100", async () => {
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`notes/n${i}.md`, "x"]));
    const { root, ctx } = project(files);
    for (let i = 0; i < 120; i++) utimesSync(path.join(root, `notes/n${i}.md`), 1_700_000_000 + i, 1_700_000_000 + i);
    const lines = (await run(ctx, "glob", { pattern: "notes/*.md" })).text.split("\n");
    expect(lines[0]).toBe("notes/n119.md");
    expect(lines[99]).toBe("notes/n20.md");
    expect(lines).toHaveLength(101);
    expect(lines[100]).toBe("(Showing 100 of 120 matching paths, newest first. Use a narrower pattern.)");
  });

  test("a pattern that matches nothing says so", async () => {
    const { ctx } = project({ "a.ts": "x" });
    expect((await run(ctx, "glob", { pattern: "**/*.py" })).text).toBe("No files match **/*.py.");
  });
});

describe("grep", () => {
  test("groups matches by file, with line numbers", async () => {
    const { ctx } = project({ "a.ts": "const x = 1;\nhit here", "b.md": "hit" });
    const { text } = await run(ctx, "grep", { pattern: "hit" });
    expect(text).toBe("a.ts\n  2: hit here\nb.md\n  1: hit");
  });

  test("include limits the files searched", async () => {
    const { ctx } = project({ "a.ts": "hit", "b.md": "hit" });
    expect((await run(ctx, "grep", { pattern: "hit", include: "*.ts" })).text).toBe("a.ts\n  1: hit");
  });

  test("stops at 250 matches and says so", async () => {
    const { ctx } = project({ "many.txt": Array.from({ length: 300 }, (_, i) => `hit ${i}`).join("\n") });
    const lines = (await run(ctx, "grep", { pattern: "hit" })).text.split("\n");
    expect(lines.filter((l) => l.startsWith("  ")).length).toBe(250);
    expect(lines.at(-1)).toBe("(Stopped at 250 matches. Narrow the pattern or set include to see the rest.)");
  });

  test("many long matches stop at the character budget, say how many were shown, and suggest narrowing", async () => {
    const { ctx } = project({ "wide.txt": Array.from({ length: 300 }, () => `hit ${"y".repeat(300)}`).join("\n") });
    const { text } = await run(ctx, "grep", { pattern: "hit" });
    const shown = text.split("\n").filter((l) => l.startsWith("  ")).length;
    expect(text.length).toBeLessThanOrEqual(30_000);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(250);
    expect(text.split("\n").at(-1)).toBe(`(Output capped at 30000 characters. Showing ${shown} matches. Narrow the pattern or set include to see the rest.)`);
  });

  test("a matched line longer than 2000 characters is cut", async () => {
    const { ctx } = project({ "long.txt": `hit${"y".repeat(2500)}` });
    const { text } = await run(ctx, "grep", { pattern: "hit" });
    expect(text).toBe(`long.txt\n  1: hit${"y".repeat(2000 - 3)}... (line truncated to 2000 chars)`);
  });

  test("an invalid regular expression is refused, and no match says so", async () => {
    const { ctx } = project({ "a.ts": "x" });
    expect((await run(ctx, "grep", { pattern: "(" })).ok).toBe(false);
    expect((await run(ctx, "grep", { pattern: "nothing" })).text).toBe("No matches.");
  });
});

const pythonOnPath = ["python", "python3"].some((cmd) => {
  try { execFileSync(cmd, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
});

describe("syntax check after a write or an edit", () => {
  test("an edit that breaks a TypeScript file is saved, and the result names the broken line", async () => {
    const { root, ctx } = project({ "app.ts": "const a = 1;\nexport const b = 2;\n" });
    const r = await run(ctx, "edit_file", { path: "app.ts", old_string: "export const b = 2;", new_string: "export const b = (2;" });
    expect(r.text).toMatch(/^Edited app\.ts \(1 replacement\)\.\nSyntax errors in app\.ts\. Fix them before you go on:\n {2}line 2: /);
    expect(readFileSync(path.join(root, "app.ts"), "utf8")).toContain("(2;");
  });

  test("a clean edit adds no note", async () => {
    const { ctx } = project({ "app.ts": "const a = 1;\n" });
    const r = await run(ctx, "edit_file", { path: "app.ts", old_string: "const a = 1;", new_string: "const a = 2;" });
    expect(r.text).toBe("Edited app.ts (1 replacement).");
  });

  test("a JSON file that does not parse is reported with the line of the error", async () => {
    const { ctx } = project({});
    const r = await run(ctx, "write_file", { path: "data.json", content: '{\n  "a": 1,\n  "b": \n}' });
    expect(r.text).toContain("line 4: ");
  });

  test("a file type this does not check adds no note", async () => {
    const { ctx } = project({});
    expect((await run(ctx, "write_file", { path: "notes.md", content: "# not code {" })).text).toBe("Created notes.md (1 lines).");
  });

  test.runIf(pythonOnPath)("a Python file that does not compile is reported with its line", async () => {
    const { ctx } = project({});
    const r = await run(ctx, "write_file", { path: "bad.py", content: "x = 1\ndef f(:\n    pass\n" });
    expect(r.text).toMatch(/line 2: /);
  });
});

describe("todo_write", () => {
  test("each call replaces the list, and the list reaches the run as todo_updated", async () => {
    const { ctx } = project({});
    const emitted: [string, unknown][] = [];
    ctx.emit = ((type: string, data: unknown) => { emitted.push([type, data]); }) as ToolContext["emit"];
    const first = await run(ctx, "todo_write", { todos: [{ content: "Read the spec", status: "in_progress" }, { content: "Write the page", status: "pending" }] });
    expect(first.text).toBe("Updated todo list: 1 pending, 1 in progress, 0 completed.");
    await run(ctx, "todo_write", { todos: [{ content: "Read the spec", status: "completed" }] });
    expect(emitted).toEqual([
      ["todo_updated", { agent_id: "agent-1", todos: [{ content: "Read the spec", status: "in_progress" }, { content: "Write the page", status: "pending" }] }],
      ["todo_updated", { agent_id: "agent-1", todos: [{ content: "Read the spec", status: "completed" }] }],
    ]);
  });

  test("a status outside pending, in_progress and completed is refused", () => {
    const tool = todoTools[0]!;
    expect(() => tool.args.parse({ todos: [{ content: "x", status: "doing" }] })).toThrow();
  });
});
/** One scripted model step per list of calls, then a plain answer. */
function stepsOf(...steps: { name: string; args: Record<string, unknown> }[][]): Script {
  let n = 0;
  return () => (n < steps.length ? { calls: steps[n++] } : { text: "done" });
}

const quietEvents = {
  text() {}, thinking() {}, thought() {}, toolStart() {}, toolArgs() {}, toolCall() {}, toolResult() {}, usage() {},
  async beforeCall() {},
};

/** Runs the real agent loop against the scripted model, and returns the transcript it built and what it sent. */
async function loop(steps: Script, tools: Tool[], ctx: ToolContext): Promise<{ input: Item[]; requests: { input: Item[] }[] }> {
  const model = await fakeModel(steps);
  const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "loop-")), "registry.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  const input: Item[] = [{ role: "user", content: "brief" }];
  try {
    await agentLoop({ reg, model: "test-model", effort: undefined, instructions: "test", input, tools, ctx, events: quietEvents, maxRounds: 6, requireStop: false, stopTools: [], keepHead: 1 });
    return { input, requests: model.requests as { input: Item[] }[] };
  } finally {
    await model.close();
  }
}

/** A tool that takes a moment and counts how many of its calls ran at once. */
function probe(name: string, readOnly: boolean, gauge: { running: number; peak: number }): Tool {
  return defineTool({
    name, description: "Takes a moment.", readOnly, args: z.object({ n: z.number() }),
    async run(_ctx, a) {
      gauge.running++;
      gauge.peak = Math.max(gauge.peak, gauge.running);
      await new Promise((resolve) => setTimeout(resolve, 40 - (a.n % 10) * 3));
      gauge.running--;
      return { text: `${name} ${a.n}` };
    },
  });
}

const calls = (name: string, count: number) => Array.from({ length: count }, (_, n) => ({ name, args: { n } }));

describe("parallel calls in one model step", () => {
  test("read-only calls run together, and their outputs come back in call order", async () => {
    const gauge = { running: 0, peak: 0 };
    const { ctx } = project({});
    const { requests } = await loop(stepsOf(calls("probe", 5)), [probe("probe", true, gauge)], ctx);
    const outputs = requests[1]!.input.filter((i) => i.type === "function_call_output").map((i) => i.output);
    expect(outputs).toEqual(["probe 0", "probe 1", "probe 2", "probe 3", "probe 4"]);
    expect(gauge.peak).toBe(5);
  });

  test("a step runs at most ten read-only calls at once, and keeps all twelve outputs in order", async () => {
    const gauge = { running: 0, peak: 0 };
    const { ctx } = project({});
    const { requests } = await loop(stepsOf(calls("probe", 12)), [probe("probe", true, gauge)], ctx);
    const outputs = requests[1]!.input.filter((i) => i.type === "function_call_output").map((i) => i.output);
    expect(outputs).toEqual(calls("probe", 12).map((c) => `probe ${c.args.n}`));
    expect(gauge.peak).toBe(10);
  });

  test("calls that change something run one at a time", async () => {
    const gauge = { running: 0, peak: 0 };
    const { ctx } = project({});
    await loop(stepsOf(calls("write", 3)), [probe("write", false, gauge)], ctx);
    expect(gauge.peak).toBe(1);
  });

  test("two reads in one step each keep their own place in the file-read ledger, and a later re-read costs one line", async () => {
    const { ctx } = project({ "a.txt": "alpha\nbeta", "b.txt": "gamma" });
    const steps = stepsOf(
      [{ name: "read_file", args: { path: "a.txt" } }, { name: "read_file", args: { path: "b.txt" } }],
      [{ name: "read_file", args: { path: "a.txt" } }],
    );
    const { input, requests } = await loop(steps, fileTools, ctx);
    const outputs = input.filter((i) => i.type === "function_call_output");
    const at = (first: string) => input.indexOf(outputs.find((o) => String(o.output).startsWith(first))!);
    expect(at("1: alpha")).toBeGreaterThan(0);
    expect(ctx.shown.get("a.txt")?.at).toBe(at("1: alpha"));
    expect(ctx.shown.get("b.txt")?.at).toBe(at("1: gamma"));
    expect(String(requests[2]!.input.at(-1)!.output)).toMatch(/^a\.txt lines 1-2 have not changed since you read them/);
  });
});

describe("browser tools by role", () => {
  const PLAYWRIGHT = [
    "browser_close", "browser_resize", "browser_console_messages", "browser_handle_dialog", "browser_evaluate",
    "browser_file_upload", "browser_fill_form", "browser_press_key", "browser_type", "browser_navigate",
    "browser_navigate_back", "browser_network_requests", "browser_run_code", "browser_take_screenshot", "browser_snapshot",
    "browser_click", "browser_drag", "browser_hover", "browser_select_option", "browser_tabs", "browser_wait_for",
  ];
  const listed = PLAYWRIGHT.map((name) => ({ name, description: name, input_schema: {} })) as McpToolOut[];

  test("a builder gets exactly its nine browser tools, in the list's order", () => {
    expect(BUILDER_BROWSER_TOOLS).toHaveLength(9);
    const picked = selectBrowserTools(listed, BUILDER_BROWSER_TOOLS).map((t) => t.name);
    expect(picked).toEqual(PLAYWRIGHT.filter((name) => BUILDER_BROWSER_TOOLS.includes(name)));
    expect(picked).toHaveLength(9);
    expect(picked).toContain("browser_resize");
  });

  test("reviewers and acceptance checks keep the whole list", () => {
    expect(selectBrowserTools(listed)).toHaveLength(PLAYWRIGHT.length);
  });
});