import { describe, expect, it } from "vitest";
import { filterRuns, groupByDay, matchesFilter, outcomeFacts, outcomeOf } from "./runsList";
import type { RunOut } from "@/types";

const outcome = (o: Partial<NonNullable<RunOut["outcome"]>> = {}) =>
  ({ tasks_total: 0, tasks_done: 0, tasks_open: 0, tasks_blocked: 0, files: 0, errors: 0, final_report: false,
     agent_turns: 0, work_turns: 0, first_deliverable_turn: null, delegations: 0, ...o });
const run = (p: Partial<RunOut>): RunOut => ({ id: "r", company_id: "c", session_id: null, goal: "g", status: "completed", mode: "autonomous",
  permission_level: "danger", budget: {}, tokens_used: 0, cost_usd: 0, turns: 0, halt_reason: "", summary: "", created_at: "2026-10-01T10:00:00",
  started_at: null, ended_at: null, outcome: outcome(), ...p }) as RunOut;

describe("outcomeOf", () => {
  it("shows success only for a delivered run", () => {
    expect(outcomeOf(run({ outcome: outcome({ final_report: true, tasks_total: 3, tasks_done: 3 }) }))).toMatchObject({ variant: "success", verified: true });
  });

  it("flags a 'completed' run that left work open or never reported (the bike-game run)", () => {
    const o = outcomeOf(run({ outcome: outcome({ tasks_total: 10, tasks_done: 2, tasks_open: 8, tasks_blocked: 3, files: 9 }) }));
    expect(o).toMatchObject({ label: "Completed", variant: "warning", verified: false });
    expect(o.caveat).toBe("Not verified: 8 tasks still open, no final report");
  });

  it("maps the other statuses", () => {
    expect(outcomeOf(run({ status: "incomplete" })).label).toBe("Incomplete");
    expect(outcomeOf(run({ status: "failed" })).variant).toBe("destructive");
    expect(outcomeOf(run({ status: "awaiting_user" })).label).toBe("Needs you");
  });
});

describe("outcomeFacts", () => {
  it("summarises tasks, files and errors", () => {
    expect(outcomeFacts(run({ outcome: outcome({ tasks_total: 10, tasks_done: 2, tasks_blocked: 3, files: 9, errors: 4 }) })))
      .toEqual(["2/10 tasks done", "3 blocked", "9 files", "4 errors"]);
    expect(outcomeFacts(run({ outcome: outcome({ files: 1 }) }))).toEqual(["1 file"]);
    expect(outcomeFacts(run({ outcome: outcome({ files: 2, agent_turns: 130, work_turns: 12, delegations: 3 }) })))
      .toEqual(["2 files", "12/130 turns did work", "3 delegations"]);
  });
});

describe("filterRuns", () => {
  const runs = [
    run({ id: "a", goal: "Build the bike game", status: "completed", created_at: "2026-10-01T09:00:00" }),
    run({ id: "b", goal: "Todo app", status: "running", created_at: "2026-10-01T11:00:00" }),
    run({ id: "c", goal: "Shooter game", status: "completed", created_at: "2026-09-29T08:00:00", outcome: outcome({ final_report: true }) }),
  ];
  it("filters by state, searches goals and sorts", () => {
    expect(filterRuns(runs, "all", "", "newest").map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(filterRuns(runs, "all", "", "oldest").map((r) => r.id)).toEqual(["c", "a", "b"]);
    expect(filterRuns(runs, "live", "", "newest").map((r) => r.id)).toEqual(["b"]);
    expect(filterRuns(runs, "all", "GAME", "newest").map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterRuns(runs, "problems", "", "newest").map((r) => r.id)).toEqual(["a"]);
    expect(matchesFilter(run({ status: "incomplete" }), "finished")).toBe(true);
  });
});

describe("groupByDay", () => {
  it("buckets runs into Today / Yesterday / dates in order", () => {
    const now = new Date("2026-10-01T15:00:00Z");
    const groups = groupByDay([run({ created_at: "2026-10-01T09:00:00" }), run({ created_at: "2026-09-30T09:00:00" }), run({ created_at: "2026-09-20T09:00:00" })], now);
    expect(groups.map((g) => g.day).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(groups).toHaveLength(3);
  });
});
