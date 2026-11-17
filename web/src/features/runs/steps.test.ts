import { describe, expect, it } from "vitest";
import { activitySummary, callStep, describeCall, fileTotals, finishStep, narrationParagraphs, phasesOf, segmentsOf, thoughtStep } from "./steps";

describe("describeCall", () => {
  it("says what a file tool did, in plain words", () => {
    expect(describeCall("read_file", { path: "index.html" })).toEqual({ kind: "read", title: "Read index.html" });
    expect(describeCall("write_file", { path: "style.css", content: "" })).toEqual({ kind: "write", title: "Wrote style.css" });
    expect(describeCall("move_file", { from: "a.md", to: "b.md" })).toEqual({ kind: "write", title: "Moved a.md to b.md" });
    expect(describeCall("glob", { pattern: "src/**" })).toEqual({ kind: "read", title: "Listed src/**" });
  });

  it("names the command that ran", () => {
    expect(describeCall("shell", { command: "npm test" })).toEqual({ kind: "command", title: "npm test" });
  });

  it("describes browser calls from both recorded forms", () => {
    expect(describeCall("mcp:browser/browser_navigate", { url: "http://127.0.0.1:8000/" })).toEqual({ kind: "browser", title: "Opened http://127.0.0.1:8000/" });
    expect(describeCall("mcp_call", { server: "browser", tool: "browser_snapshot" })).toEqual({ kind: "browser", title: "Read the page" });
  });

  it("adds no step for calls whose message already shows in the chat", () => {
    expect(describeCall("reply_to_user", { message: "Hello" })).toBeNull();
    expect(describeCall("ask_user", { question: "Which colour?" })).toBeNull();
  });

  it("falls back to the tool name with spaces for unknown tools", () => {
    expect(describeCall("some_new_tool", {})).toEqual({ kind: "other", title: "some new tool" });
  });
});

describe("describeCall for the team's own tools", () => {
  it("names the skill, the task list, and the dev server in plain words", () => {
    expect(describeCall("skill", { name: "landing-page" })).toEqual({ kind: "read", title: "Loaded the landing-page skill" });
    expect(describeCall("todo_write", { todos: [] })).toEqual({ kind: "task", title: "Updated the todo list" });
    expect(describeCall("start_dev_server", {})).toEqual({ kind: "command", title: "Started the dev server" });
  });
});

describe("steps", () => {
  it("starts a call as running and finishes it with the output", () => {
    const step = callStep(7, { call_id: "c1", agent_id: "a", tool: "read_file", args: { path: "a.js" } });
    expect(step).toMatchObject({ id: "c1", seq: 7, kind: "read", title: "Read a.js", status: "running" });
    expect(finishStep(step!, false, "missing")).toMatchObject({ status: "failed", detail: "missing" });
  });

  it("uses the first line of a thought as its title and keeps the whole text", () => {
    const step = thoughtStep(3, "a", "## Plan\nFirst check the spec.\nThen build.");
    expect(step).toMatchObject({ kind: "thought", title: "Plan", detail: "## Plan\nFirst check the spec.\nThen build." });
    expect(thoughtStep(4, "a", "**Planning an empty project**").title).toBe("Planning an empty project");
  });
});

describe("activitySummary", () => {
  const tool = (seq: number, call_id: string, toolName: string, args: Record<string, unknown>) => callStep(seq, { call_id, agent_id: "a", tool: toolName, args })!;

  it("says what a run of tool steps did, once per kind, in the order they ran", () => {
    expect(activitySummary([tool(1, "c1", "read_file", { path: "a.ts" }), tool(2, "c2", "shell", { command: "npm test" }), tool(3, "c3", "read_file", { path: "b.ts" })])).toBe("Read files, ran commands");
  });

  it("is empty for a thought with no tool steps", () => {
    expect(activitySummary([thoughtStep(1, "a", "Plan.")])).toBe("");
  });
});

describe("file changes", () => {
  const tool = (seq: number, call_id: string, toolName: string, args: Record<string, unknown>) => callStep(seq, { call_id, agent_id: "a", tool: toolName, args })!;

  it("counts the lines an edit removed and added, and a write's whole content as added", () => {
    expect(tool(1, "c1", "edit_file", { path: "app.js", old_string: "a\nb", new_string: "a\nb\nc" }).file).toEqual({ path: "app.js", added: 3, removed: 2 });
    expect(tool(2, "c2", "write_file", { path: "index.html", content: "x\ny" }).file).toEqual({ path: "index.html", added: 2, removed: 0 });
    expect(tool(3, "c3", "read_file", { path: "a.ts" }).file).toBeUndefined();
  });

  it("totals each file across its edits, in the order the files were first changed, and skips failed edits", () => {
    const failed = finishStep(tool(4, "c4", "edit_file", { path: "app.js", old_string: "x", new_string: "y\nz" }), false, "not found");
    const steps = [
      tool(1, "c1", "edit_file", { path: "app.js", old_string: "a", new_string: "b" }),
      tool(2, "c2", "write_file", { path: "index.html", content: "1\n2" }),
      tool(3, "c3", "edit_file", { path: "app.js", old_string: "b\nc", new_string: "d" }),
      failed,
    ];
    expect(fileTotals(steps)).toEqual([{ path: "app.js", added: 2, removed: 3 }, { path: "index.html", added: 2, removed: 0 }]);
  });

  it("splits a run of steps into file changes and other actions, keeping their order", () => {
    const steps = [
      tool(1, "c1", "read_file", { path: "a.ts" }),
      tool(2, "c2", "edit_file", { path: "a.ts", old_string: "a", new_string: "b" }),
      tool(3, "c3", "write_file", { path: "b.ts", content: "x" }),
      tool(4, "c4", "shell", { command: "npm test" }),
    ];
    expect(segmentsOf(steps).map((s) => [s.kind, s.steps.length])).toEqual([["actions", 1], ["files", 2], ["actions", 1]]);
  });
});

describe("narrationParagraphs", () => {
  it("keeps a thought's own paragraphs", () => {
    expect(narrationParagraphs("First para.\n\nSecond para.")).toEqual(["First para.", "Second para."]);
  });

  it("splits a long paragraph between sentences, into chunks no longer than the limit", () => {
    expect(narrationParagraphs("A one. B two. C three.", 10)).toEqual(["A one.", "B two.", "C three."]);
    expect(narrationParagraphs("A one. B two. C three.", 20)).toEqual(["A one. B two.", "C three."]);
  });

  it("returns nothing for empty text", () => {
    expect(narrationParagraphs("   ")).toEqual([]);
  });
});

describe("phasesOf", () => {
  const tool = (seq: number, call_id: string, toolName: string, args: Record<string, unknown>) => callStep(seq, { call_id, agent_id: "a", tool: toolName, args })!;

  it("opens a phase at each thought, with the tool steps after it", () => {
    const phases = phasesOf([
      thoughtStep(1, "a", "Plan the page."),
      tool(2, "c2", "read_file", { path: "a.ts" }),
      tool(3, "c3", "shell", { command: "npm test" }),
      thoughtStep(4, "a", "Build it."),
      tool(5, "c5", "write_file", { path: "b.ts", content: "" }),
    ]);
    expect(phases.map((p) => p.thought?.title)).toEqual(["Plan the page.", "Build it."]);
    expect(phases.map((p) => p.steps.length)).toEqual([2, 1]);
  });

  it("keeps tool steps that ran before any thought in a phase with no title", () => {
    const phases = phasesOf([tool(1, "c1", "read_file", { path: "a.ts" }), thoughtStep(2, "a", "Plan."), tool(3, "c3", "shell", { command: "ls" })]);
    expect(phases.map((p) => p.thought?.title ?? null)).toEqual([null, "Plan."]);
    expect(phases[0]!.steps).toHaveLength(1);
  });
});
