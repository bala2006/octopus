import { describe, expect, it } from "vitest";
import type { BrowserAction } from "./runState";
import { consoleLines, consoleTotals, hostOf } from "./browserSteps";

const step = (agent_id: string, output?: string, tool = "browser_console_messages"): BrowserAction => ({
  seq: 1, agent_id, tool, args: {}, ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null, output,
});

// The text Playwright MCP returned for browser_console_messages on a page that logged each level, with one
// multi-line log, an assert, and an uncaught error thrown later. The stack is shortened.
const CAPTURED = [
  "### Result",
  'Total messages: 8 (Errors: 2, Warnings: 1)',
  'Returning 7 messages for level "info"',
  "",
  "[LOG] booted @ :2",
  "[WARNING] deprecated API @ :3",
  "[ERROR] Uncaught TypeError: x is not a function @ :4",
  "[INFO] info line @ :5",
  "[LOG] multi",
  "line @ :7",
  "[ASSERT] assert msg @ :8",
  "Error: boom late",
  "    at data:text/html,probe:9:26",
  "### Page",
  "- Page URL: data:text/html,probe",
  "- Page Title: Console probe",
  "- Console: 2 errors, 1 warnings",
  "### Events",
  "- New console entries: .playwright-mcp\\console-2026-11-17T16-10-56-705Z.log#L8-L9",
].join("\n");

describe("console messages in a browser step", () => {
  it("reads every entry of the captured tool output, with its level and location", () => {
    expect(consoleLines(step("a", CAPTURED))).toEqual([
      { level: "info", text: "booted", where: "line 2" },
      { level: "warning", text: "deprecated API", where: "line 3" },
      { level: "error", text: "Uncaught TypeError: x is not a function", where: "line 4" },
      { level: "info", text: "info line", where: "line 5" },
      { level: "info", text: "multi\nline", where: "line 7" },
      { level: "error", text: "assert msg", where: "line 8" },
      { level: "error", text: "Error: boom late\n    at data:text/html,probe:9:26" },
    ]);
  });

  it("keeps the url of an entry from a real page", () => {
    const output = "### Result\nTotal messages: 1 (Errors: 0, Warnings: 0)\n\n[LOG] ready @ http://127.0.0.1:8000/snake.js:42";
    expect(consoleLines(step("a", output))).toEqual([
      { level: "info", text: "ready", where: "http://127.0.0.1:8000/snake.js:42" },
    ]);
  });

  it("reads nothing from other browser tools, which print no console entries", () => {
    expect(consoleLines(step("a", "### Error\nError: net::ERR_CONNECTION_REFUSED", "browser_navigate"))).toEqual([]);
    expect(consoleLines(step("a", "[ERROR] looks like one", "browser_click"))).toEqual([]);
  });

  it("reads nothing from a step without output, or from a call that found no messages", () => {
    expect(consoleLines(step("a", undefined))).toEqual([]);
    expect(consoleLines(step("a", "### Result\nTotal messages: 0 (Errors: 0, Warnings: 0)\n\n"))).toEqual([]);
  });

  it("counts each distinct error and warning of one agent once, across repeated calls", () => {
    const actions = [
      step("a", "### Result\n[ERROR] one @ :1\n[WARNING] two @ :2"),
      step("b", "### Result\n[ERROR] other agent @ :1"),
      step("a", "### Result\n[ERROR] one @ :1\n[ERROR] three @ :3"),
    ];

    expect(consoleTotals(actions, "a")).toEqual({ errors: 2, warnings: 1 });
    expect(consoleTotals(actions, "nobody")).toEqual({ errors: 0, warnings: 0 });
  });
});

describe("step labels", () => {
  it("names the host of a page, and nothing for a blank tab", () => {
    expect(hostOf("http://127.0.0.1:8000/snake?x=1")).toBe("127.0.0.1:8000");
    expect(hostOf("about:blank")).toBe("");
  });
});
