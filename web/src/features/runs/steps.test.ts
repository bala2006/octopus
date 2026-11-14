import { describe, expect, it } from "vitest";
import { callStep, countLine, describeCall, finishStep, thoughtStep } from "./steps";

describe("describeCall", () => {
  it("says what a file tool did, in plain words", () => {
    expect(describeCall("read_file", { path: "index.html" })).toEqual({ kind: "read", title: "Read index.html" });
    expect(describeCall("write_file", { path: "style.css", content: "" })).toEqual({ kind: "write", title: "Wrote style.css" });
    expect(describeCall("move_file", { from: "a.md", to: "b.md" })).toEqual({ kind: "write", title: "Moved a.md to b.md" });
    expect(describeCall("list_files", {})).toEqual({ kind: "read", title: "Listed the project files" });
  });

  it("names the command that ran", () => {
    expect(describeCall("run_command", { command: "npm test" })).toEqual({ kind: "command", title: "Ran npm test" });
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

describe("countLine", () => {
  const tool = (seq: number, call_id: string, toolName: string, args: Record<string, unknown>) => callStep(seq, { call_id, agent_id: "a", tool: toolName, args })!;

  it("counts each kind of tool step, in the order the group ran them", () => {
    const steps = [
      tool(1, "c1", "run_command", { command: "npm test" }),
      tool(2, "c2", "read_file", { path: "a.ts" }),
      tool(3, "c3", "run_command", { command: "npm run build" }),
      tool(4, "c4", "remember", { key: "style" }),
    ];
    expect(countLine(steps)).toBe("+ 2 commands, 1 read, 1 tool");
  });

  it("leaves thoughts out of the count when the group has tool steps, and counts them when it has nothing else", () => {
    expect(countLine([thoughtStep(1, "a", "Check the spec."), tool(2, "c2", "read_file", { path: "a.ts" })])).toBe("+ 1 read");
    expect(countLine([thoughtStep(1, "a", "One."), thoughtStep(2, "a", "Two.")])).toBe("+ 2 thoughts");
  });
});
