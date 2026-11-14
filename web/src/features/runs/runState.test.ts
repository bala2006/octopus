import { describe, expect, it } from "vitest";
import { initialRun, reduceRun, replayTo, TERMINAL } from "./runState";
import type { RunEvent } from "@/types";

const msg = (id: string, from: string | null, to: string | null, type = "task", content = "hello"): RunEvent => ({
  type: "message_created", seq: Number(id), data: { message: { id, run_id: "r", session_id: null, sender: from ? "agent" : "user", from_agent_id: from, to_agent_id: to, edge_id: null, type, content, meta: {}, turn_no: 1, created_at: "2026-09-30T10:00:00" } },
});

describe("reduceRun", () => {
  it("keeps every thought and tool call as a step, in order, and finishes each call with its result", () => {
    const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ type, seq, data }) as unknown as RunEvent;
    let s = reduceRun(initialRun(), ev(1, "thought", { agent_id: "a", text: "Check the spec first." }), {});
    s = reduceRun(s, ev(2, "tool_call", { call_id: "c1", agent_id: "a", tool: "read_file", args: { path: "spec.md" } }), {});
    s = reduceRun(s, ev(3, "tool_result", { call_id: "c1", agent_id: "a", tool: "read_file", ok: true, output: "# Spec" }), {});
    s = reduceRun(s, ev(4, "tool_call", { call_id: "c2", agent_id: "a", tool: "reply_to_user", args: { message: "Hi" } }), {});
    expect(s.steps).toEqual([
      expect.objectContaining({ seq: 1, kind: "thought", title: "Check the spec first.", detail: "Check the spec first.", status: "ok" }),
      expect.objectContaining({ id: "c1", kind: "read", title: "Read spec.md", detail: "# Spec", status: "ok" }),
    ]);
  });

  it("tracks the workflow and puts each phase handoff on the timeline", () => {
    const wf = (active: string, loops = 0) => ({ track: "quick", index: 1, ended: false, phases: ["intake", "build", "test", "accept"].map((k) => ({
      key: k, title: k[0].toUpperCase() + k.slice(1), owner: k === "build" ? "b" : k === "test" ? "q" : "h",
      status: k === active ? "active" : k === "intake" ? "done" : "pending", loops: k === "build" ? loops : 0 })) });
    let s = reduceRun(initialRun(), { type: "workflow_updated", seq: 1, data: { workflow: wf("build") } }, { b: "Sam" });
    expect(s.workflow?.track).toBe("quick");
    expect(s.timeline.at(-1)).toMatchObject({ tone: "protocol", label: "Build → Sam" });
    s = reduceRun(s, { type: "workflow_updated", seq: 2, data: { workflow: wf("build") } }, { b: "Sam" });
    expect(s.timeline).toHaveLength(1); // same phase: no new entry
    s = reduceRun(s, { type: "workflow_updated", seq: 3, data: { workflow: wf("test") } }, { q: "Quinn" });
    s = reduceRun(s, { type: "workflow_updated", seq: 4, data: { workflow: wf("build", 1) } }, { b: "Sam" });
    expect(s.timeline.at(-1)?.label).toBe("Build → Sam (fix round 1)");
  });


  it("treats incomplete as a terminal status", () => {
    expect(TERMINAL.has("incomplete")).toBe(true);
    expect(TERMINAL.has("paused")).toBe(false);
  });

  it("closes the steps, tool calls and workflow phase that a stopped run left open", () => {
    const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ type, seq, data }) as unknown as RunEvent;
    const workflow = { track: "quick", index: 1, ended: false, phases: [
      { key: "build", title: "Build", owner: "r", status: "active" }, { key: "review", title: "Review", owner: "q", status: "pending" },
    ] };
    let s = reduceRun(initialRun(), ev(1, "workflow_updated", { workflow }), {});
    s = reduceRun(s, ev(2, "tool_call", { call_id: "c1", agent_id: "a", tool: "run_command", args: { command: "npm test" } }), {});
    s = reduceRun(s, ev(3, "run_status", { status: "running" }), {});
    expect(s.steps[0]).toMatchObject({ status: "running" });
    s = reduceRun(s, ev(4, "run_status", { status: "incomplete", reason: "Reached the token limit" }), {});
    expect(s.steps[0]).toMatchObject({ id: "c1", status: "failed" });
    expect(s.toolCalls.c1.ok).toBe(false);
    expect(s.workflow).toMatchObject({ ended: true });
    expect(s.workflow?.phases.map((p) => p.status)).toEqual(["failed", "pending"]);
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
