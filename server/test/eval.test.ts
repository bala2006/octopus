/**
 * The eval harness: the grader must tell a passing project from a failing one, and the first task must run end to end
 * through the real engine against the scripted model, with the fix made by tool calls.
 */
import path from "node:path";
import { existsSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gradeProject, listTasks, loadTask, TASKS_DIR } from "../eval/grade";
import { runEval } from "../eval/run";
import { loadScenario } from "../eval/scriptedModel";

const copyRepo = (task: string) => {
  const dir = mkdtempSync(path.join(process.env.TEST_BASE_DIR!, `${task}-`));
  cpSync(path.join(TASKS_DIR, task, "repo"), dir, { recursive: true });
  return dir;
};

describe("grader", () => {
  test("the starting project fails and the fixed project passes", async () => {
    const broken = copyRepo("fix-pagination");
    const failing = await gradeProject("fix-pagination", broken);
    expect(failing.graded).toBe(true);
    expect(failing.pass).toBe(false);
    expect(failing.checks.find((c) => c.name === "page 1 holds a full page of 3")?.pass).toBe(false);

    const fixed = copyRepo("fix-pagination");
    const src = path.join(fixed, "src", "paginate.ts");
    writeFileSync(src, readFileSync(src, "utf8").replace("start + pageSize - 1", "start + pageSize"));
    const passing = await gradeProject("fix-pagination", fixed);
    expect(passing.pass).toBe(true);
    expect(passing.checks.every((c) => c.pass)).toBe(true);
  }, 120_000);

  test("every task has a grader folder and a starting project", () => {
    for (const task of listTasks()) {
      expect(existsSync(path.join(TASKS_DIR, task, "hidden"))).toBe(true);
      expect(existsSync(path.join(TASKS_DIR, task, "repo"))).toBe(true);
    }
  });

  test("a task whose grader is not run reports not run, not a pass", async () => {
    const spec = loadTask("todo-page");
    expect(spec.grader.run).toBe(false);
    const grade = await gradeProject("todo-page", copyRepo("todo-page"));
    expect(grade).toMatchObject({ graded: false, pass: null, checks: [] });
    expect(grade.reason).toMatch(/browser/);
  });
});

describe("scripted scenarios", () => {
  test("every scenario file parses", () => {
    for (const file of ["fix-pagination.json", "one-file-edit.json", "screenshots.json", "parallel-miss.json"]) {
      expect(loadScenario(file).description.length).toBeGreaterThan(0);
    }
    expect(loadScenario("one-file-edit.json").description).toMatch(/landing page/);
  });
});

describe("eval run", () => {
  test("fix-pagination runs end to end against the scripted model and passes", async () => {
    const [row] = await runEval({ mode: "pipeline", template: "solo_engineer", tasks: ["fix-pagination"], repeat: 1 });
    expect(row).toBeDefined();
    expect(row!.run_status).toBe("completed");
    expect(row!.graded).toBe(true);
    expect(row!.pass).toBe(true);
    expect(row!.checks_passed).toBe(row!.checks_total);
    expect(row!.model_calls).toBeGreaterThan(0);
    expect(row!.unmatched_replies).toBe(0);
    expect(row!.tool_failures).toBe(0);
    expect(existsSync(path.join(row!.workdir, "hidden"))).toBe(false);
    expect(readFileSync(path.join(row!.workdir, "src", "paginate.ts"), "utf8")).toContain("start + pageSize);");
  }, 120_000);

  test("fix-pagination runs in solo mode against the scripted model, and the fix is made with tool calls", async () => {
    const [row] = await runEval({ mode: "solo", tasks: ["fix-pagination"], repeat: 1 });
    expect(row).toMatchObject({ mode: "solo", template: "solo", run_status: "completed", graded: true, pass: true, checks_passed: 5, checks_total: 5 });
    expect(row!.model_calls).toBe(3);
    expect(row!.tool_calls).toBe(2);
    expect(row!.unmatched_replies).toBe(0);
    expect(readFileSync(path.join(row!.workdir, "src", "paginate.ts"), "utf8")).toContain("start + pageSize);");
  }, 120_000);
});

