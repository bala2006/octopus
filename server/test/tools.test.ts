/** The file tools run against a real folder, with the engine's context reduced to the fields they touch. */
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileTools } from "../src/tools/files";
import { ProjectFs } from "../src/safety/paths";
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
  const tool: Tool = fileTools.find((t) => t.name === name)!;
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
