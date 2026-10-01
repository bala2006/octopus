import { describe, expect, it } from "vitest";
import { initialRun, reduceRun, replayTo, TERMINAL } from "./runState";
import type { RunEvent } from "@/types";

const msg = (id: string, from: string | null, to: string | null, type = "task", content = "hello"): RunEvent => ({
  type: "message_created", seq: Number(id), data: { message: { id, run_id: "r", session_id: null, sender: from ? "agent" : "user", from_agent_id: from, to_agent_id: to, edge_id: null, type, content, meta: {}, turn_no: 1, created_at: "2026-09-30T10:00:00" } },
});

describe("reduceRun", () => {
  it("makes skipped turns and stalls visible", () => {
    let s = reduceRun(initialRun(), { type: "turn_skipped", seq: 1, data: { agent_id: "a", limit: 12, inbox: [] } }, { a: "Alice" });
    expect(s.timeline.at(-1)).toMatchObject({ tone: "error", label: "Alice skipped: over 12 autonomous turns" });
    s = reduceRun(s, { type: "usage_update", seq: 2, data: { tokens: 10, cost_usd: 0, turns: 30, progress_turn: 9, turns_since_progress: 21 } });
    expect(s.usage).toMatchObject({ progress_turn: 9, turns_since_progress: 21 });
  });

  it("treats incomplete as a terminal status", () => {
    expect(TERMINAL.has("incomplete")).toBe(true);
    expect(TERMINAL.has("paused")).toBe(false);
  });

  it("tracks statuses, streaming and last message", () => {
    let s = initialRun();
    s = reduceRun(s, { type: "agent_status", data: { agent_id: "a", status: "speaking", activity: "Drafting proposal to Bob…" } });
    s = reduceRun(s, { type: "token_stream", data: { agent_id: "a", delta: '{"actions":' } });
    expect(s.agentStatus.a).toBe("speaking");
    expect(s.activity.a).toContain("Drafting");
    expect(s.streaming.a).toBe('{"actions":');
    s = reduceRun(s, msg("1", "a", "b", "proposal", "Use Postgres"), { a: "Alice", b: "Bob" });
    expect(s.lastMessage.a).toMatchObject({ type: "proposal", to: "Bob" });
    expect(s.timeline.at(-1)?.label).toBe("Alice › Bob · proposal");
    s = reduceRun(s, { type: "agent_status", data: { agent_id: "a", status: "idle" } });
    expect(s.streaming.a).toBe("");
  });

  it("de-duplicates replayed messages and handles approvals", () => {
    let s = reduceRun(initialRun(), msg("1", null, "a"));
    s = reduceRun(s, msg("1", null, "a"));
    expect(s.messages).toHaveLength(1);
    s = reduceRun(s, { type: "approval_requested", seq: 2, data: { id: "x", agent_id: "a", kind: "write_file", summary: "write a.py", preview: "", details: {} } });
    expect(s.pendingApproval?.id).toBe("x");
    s = reduceRun(s, { type: "approval_resolved", seq: 3, data: { id: "x", approved: true } });
    expect(s.pendingApproval).toBeNull();
  });

  it("replays to a cursor", () => {
    const events = [msg("1", null, "a"), msg("2", "a", "b"), msg("3", "b", "a", "answer")];
    expect(replayTo(events, 2, {}).messages.map((m) => m.id)).toEqual(["1", "2"]);
    expect(replayTo(events, 3, {}).messages).toHaveLength(3);
  });
});

describe("org events", () => {
  it("adds hired agents, patches edits and records the timeline", () => {
    let s = initialRun();
    s = reduceRun(s, { type: "agent_created", seq: 5, data: {
      agent: { id: "n1", name: "Omar", role: "Engineering Manager", department: "Engineering", created_by: "f" }, edges: [{ id: "e1", source_agent_id: "f", target_agent_id: "n1", type: "delegate" }],
      created_by: "f", persisted: true, department: { name: "Engineering", color: "#10b981" } } }, { f: "Nova" });
    expect(s.extraAgents.map((a) => a.name)).toEqual(["Omar"]);
    expect(s.extraEdges).toHaveLength(1);
    expect(s.departments.Engineering.color).toBe("#10b981");
    expect(s.timeline.at(-1)?.label).toBe("Nova hired Omar (Engineering Manager)");
    s = reduceRun(s, { type: "agent_updated", seq: 6, data: { agent_id: "n1", by: "f", self: false, changes: { role: "VP Engineering", active: false }, summary: "role", old_name: "Omar" } }, { f: "Nova" });
    expect(s.agentPatches.n1).toMatchObject({ role: "VP Engineering", active: false });
    expect(s.orgEvents.map((e) => e.kind)).toEqual(["created", "updated"]);
    expect(replayTo([{ type: "agent_created", seq: 5, data: { agent: { id: "n1", name: "Omar", role: "x" }, edges: [], created_by: "f" } }], 4, {}).extraAgents).toHaveLength(0);
  });
});
