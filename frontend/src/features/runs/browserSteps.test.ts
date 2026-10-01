import { describe, expect, it } from "vitest";
import type { RunEvent } from "@/types";
import { initialRun, reduceRun, replayTo, type BrowserAction } from "./runState";
import { browserAgents, describeAction, frameFor, isBrowsing } from "./browserSteps";

const act = (seq: number, agent_id: string, tool: string, args: Record<string, unknown> = {}, extra: Partial<BrowserAction> = {}): RunEvent => ({
  type: "browser_action", seq, data: { agent_id, call_id: `c${seq}`, tool, args, ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null, ...extra },
});

describe("browser view", () => {
  const events = [
    { type: "tool_call", seq: 1, data: { call_id: "c2", agent_id: "a", tool: "mcp:browser/browser_navigate", args: { server: "browser", tool: "browser_navigate" } } },
    { type: "tool_result", seq: 2, data: { call_id: "c2", agent_id: "a", tool: "mcp_call", ok: true, output: "…" } },
    act(3, "a", "browser_navigate", { url: "http://127.0.0.1:8000/" }, { frame: "000001.jpeg" }),
    act(4, "b", "browser_snapshot"),
    act(5, "a", "browser_click", { element: "Start button", target: "e12" }, { ok: false, frame: null, note: "Ref e12 not found" }),
  ] as RunEvent[];

  it("records each step in order with one timeline entry per step", () => {
    const s = events.reduce((st, e) => reduceRun(st, e, { a: "Ann", b: "Bo" }), initialRun());
    expect(s.browser.map((x) => [x.agent_id, x.tool])).toEqual([["a", "browser_navigate"], ["b", "browser_snapshot"], ["a", "browser_click"]]);
    expect(s.timeline.map((t) => t.label)).toEqual(["Ann opened Snake", "Bo read the page", "Ann clicked (failed)"]);
    expect(s.timeline.some((t) => t.label.includes("called MCP")), "no duplicate generic entry for browser calls").toBe(false);
  });

  it("works on replay, so a finished run can still be watched step by step", () => {
    expect(replayTo(events, 3, {}).browser).toHaveLength(1);
  });

  it("lists browsing agents most recent first and describes steps in words", () => {
    const s = events.reduce((st, e) => reduceRun(st, e), initialRun());
    expect(browserAgents(s.browser)).toEqual(["a", "b"]);
    expect(describeAction(s.browser[0])).toBe("opened http://127.0.0.1:8000/");
    expect(describeAction(s.browser[2])).toBe("clicked “Start button”");
    expect(describeAction({ ...s.browser[0], tool: "browser_type", args: { element: "Name", text: "Ada", submit: true } }))
      .toBe("typed “Ada” into Name and pressed Enter");
  });

  it("shows the last screenshot of the same agent when a step has none", () => {
    const s = events.reduce((st, e) => reduceRun(st, e), initialRun());
    expect(frameFor(s.browser, 2)?.frame).toBe("000001.jpeg"); // Ann's failed click: still her tab after navigating
    expect(frameFor(s.browser, 1)).toBeNull(); // Bo has no screenshot; Ann's is not his tab
  });

  it("knows when an agent is in the browser right now", () => {
    expect(isBrowsing("Browser: click…")).toBe(true);
    expect(isBrowsing("Writing index.html")).toBe(false);
    expect(isBrowsing(undefined)).toBe(false);
  });
});
