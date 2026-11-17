import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { AgentOut } from "@/types";
import { initialRun, type BrowserAction, type RunLive } from "./runState";
import { BrowserView } from "./BrowserView";

const navigate: BrowserAction = {
  seq: 1, ts: "2026-11-16T10:00:01Z", agent_id: "a", call_id: "c1", tool: "browser_navigate", args: { url: "http://127.0.0.1:8000/" },
  ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null,
  output: "### Page\n- Page URL: http://127.0.0.1:8000/\n- Page Title: Snake\n- Console: 1 errors, 1 warnings",
};
const readFirst: BrowserAction = {
  seq: 2, ts: "2026-11-16T10:00:02Z", agent_id: "a", call_id: "c2", tool: "browser_console_messages", args: {},
  ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null,
  output: "### Result\nTotal messages: 2 (Errors: 0, Warnings: 1)\n\n[LOG] booted @ :2\n[WARNING] deprecated API @ :3",
};
const click: BrowserAction = {
  seq: 3, ts: "2026-11-16T10:00:05Z", agent_id: "a", call_id: "c3", tool: "browser_click", args: { element: "Start button", ref: "e12" },
  ok: false, url: "http://127.0.0.1:8000/", title: "Snake", frame: null,
  output: "Ref e12 not found",
};
const readLatest: BrowserAction = {
  seq: 4, ts: "2026-11-16T10:00:06Z", agent_id: "a", call_id: "c4", tool: "browser_console_messages", args: {},
  ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null,
  output: "### Result\nTotal messages: 1 (Errors: 1, Warnings: 0)\n\n[ERROR] Uncaught TypeError: x is not a function @ :4",
};

const state: RunLive = { ...initialRun(), browser: [navigate, readFirst, click, readLatest], activity: {}, agentStatus: {} };
const agents = { a: { id: "a", name: "Ann", color: "#3b82f6", avatar: "palette" } as unknown as AgentOut };

// jsdom has no layout, so the list's scroll-into-view call is a no-op here.
Element.prototype.scrollIntoView = () => {};

describe("Browser tab", () => {
  it("summarises the agent's steps, failures, and distinct console problems", () => {
    render(<BrowserView state={state} agents={agents} w="ws" runId="r1" />);
    const summary = screen.getByTestId("browser-summary");

    expect(within(summary).getByText("4 steps")).toBeTruthy();
    expect(within(summary).getByText("1 failed")).toBeTruthy();
    expect(within(summary).getByText("1 distinct console error")).toBeTruthy();
    expect(within(summary).getByText("1 distinct warning")).toBeTruthy();
  });

  it("opens the latest step on its console tab, and switches to an earlier console step", () => {
    render(<BrowserView state={state} agents={agents} w="ws" runId="r1" />);

    expect(screen.getByRole("tab", { name: /Console/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Uncaught TypeError: x is not a function")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /read the console/ })[0]!);

    expect(screen.getByText("booted")).toBeTruthy();
    expect(screen.getByText("deprecated API")).toBeTruthy();
  });

  it("filters the step list to failures", () => {
    render(<BrowserView state={state} agents={agents} w="ws" runId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));

    expect(screen.queryByRole("button", { name: /opened http:\/\/127\.0\.0\.1:8000\// })).toBeNull();
    expect(screen.getByRole("button", { name: /clicked .Start button/ })).toBeTruthy();
  });

  it("filters the step list to steps that printed a console error", () => {
    render(<BrowserView state={state} agents={agents} w="ws" runId="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "Console errors" }));

    expect(screen.getAllByRole("button", { name: /read the console/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /clicked .Start button/ })).toBeNull();
  });

  it("says so when a console step was recorded before its output was saved", () => {
    const old: BrowserAction = { ...readLatest, seq: 9, output: undefined };
    render(<BrowserView state={{ ...state, browser: [old] }} agents={agents} w="ws" runId="r1" />);

    fireEvent.click(screen.getByRole("tab", { name: /Console/ }));
    expect(screen.getByText("This step's output was not saved, so its console messages are not available.")).toBeTruthy();
  });
});
