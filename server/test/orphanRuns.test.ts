import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openProject, pauseOrphanedRuns, type ProjectDb, RESTART_REASON } from "../src/db/project";

function openTemp(): { root: string; project: ProjectDb } {
  const root = mkdtempSync(path.join(tmpdir(), "orphans-"));
  mkdirSync(path.join(root, ".octopus"), { recursive: true });
  return { root, project: openProject(root) };
}

function addRun(p: ProjectDb, id: string, status: string, halt: string, state: object, lastStatus?: string) {
  p.db.run(
    "INSERT INTO runs (id, company_id, goal, status, mode, budget, permission_level, snapshot, state, created_at, halt_reason) VALUES (?, 'co', 'goal', ?, 'autonomous', '{}', 'auto', '{}', ?, '2026-01-01T00:00:00.000Z', ?)",
    id, status, JSON.stringify(state), halt,
  );
  if (lastStatus) p.db.run("INSERT INTO run_events (run_id, type, data, ts) VALUES (?, 'run_status', ?, '2026-01-01T00:00:00.000Z')", id, JSON.stringify({ status: lastStatus }));
}

function log(p: ProjectDb, id: string) {
  return p.db.all<{ type: string; data: string }>("SELECT type, data FROM run_events WHERE run_id = ? ORDER BY seq", id)
    .map((e) => ({ type: e.type, data: JSON.parse(e.data) as Record<string, unknown> }));
}

function row(p: ProjectDb, id: string) {
  return p.db.get<{ status: string; halt_reason: string; state: string }>("SELECT status, halt_reason, state FROM runs WHERE id = ?", id)!;
}

describe("runs a stopped process left behind", () => {
  test("opening the project pauses the run in its row and its event log, and agents that were thinking go idle", () => {
    const { root, project } = openTemp();
    addRun(project, "r1", "running", "", { agent_status: { lena: "thinking", iris: "done" } }, "running");
    const reopened = openProject(root);
    expect(row(reopened, "r1").status).toBe("paused");
    expect(row(reopened, "r1").halt_reason).toBe(RESTART_REASON);
    const events = log(reopened, "r1");
    expect(events.filter((e) => e.type === "run_status").at(-1)?.data).toMatchObject({ status: "paused", reason: RESTART_REASON });
    expect(events.filter((e) => e.type === "agent_status")).toEqual([{ type: "agent_status", data: { agent_id: "lena", status: "idle", activity: "" } }]);
    expect(JSON.parse(row(reopened, "r1").state).agent_status).toEqual({ lena: "idle", iris: "done" });
  });

  test("pausing again writes nothing", () => {
    const { project } = openTemp();
    addRun(project, "r1", "running", "", { agent_status: {} }, "running");
    pauseOrphanedRuns(project);
    const before = log(project, "r1").length;
    pauseOrphanedRuns(project);
    expect(log(project, "r1")).toHaveLength(before);
  });

  test("a paused run whose log still ends in running gets the pause, as written by an earlier version", () => {
    const { project } = openTemp();
    addRun(project, "r2", "paused", RESTART_REASON, { agent_status: {} }, "running");
    pauseOrphanedRuns(project);
    expect(log(project, "r2").filter((e) => e.type === "run_status").at(-1)?.data).toMatchObject({ status: "paused" });
  });

  test("a run a person paused is left alone", () => {
    const { project } = openTemp();
    addRun(project, "r3", "paused", "", { agent_status: {} }, "paused");
    pauseOrphanedRuns(project);
    expect(log(project, "r3")).toHaveLength(1);
  });
});
