/** The file tools run against a real folder, with the engine's context reduced to the fields they touch. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileTools } from "../src/tools/files";
import { ProjectFs } from "../src/safety/paths";
import { todoTools } from "../src/tools/todo";
import type { Tool, ToolContext } from "../src/tools/types";

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