import type { PlanStep } from "@octopus/shared";
import { checkPlan } from "../src/engine/plan";

const step = (over: Partial<PlanStep> & { id: string }): PlanStep => ({
  role: "explorer", purpose: "find out what the product does", depends_on: [], produces: [], inputs: [], reason: "the request names a product", ...over,
});

describe("checkPlan", () => {
  test("a one-step plan is valid", () => {
    expect(checkPlan([step({ id: "build", role: "main", produces: ["index.html"] })])).toEqual({ ok: true, errors: [] });
  });

  test("a step may read what a step it depends on produces", () => {
    const plan = [
      step({ id: "research", produces: ["research.md"] }),
      step({ id: "build", role: "main", depends_on: ["research"], inputs: ["research.md"] }),
    ];
    expect(checkPlan(plan).ok).toBe(true);
  });

  test("duplicate ids, a missing role or reason, and an empty purpose are reported", () => {
    const result = checkPlan([step({ id: "a" }), step({ id: "a", role: "", reason: "" , purpose: " " })]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "Step id a is used twice.",
      "Step a has no role.",
      "Step a has no purpose.",
      "Step a needs a reason for its role.",
    ]));
  });

  test("a dependency on a step that is not in the plan is reported", () => {
    expect(checkPlan([step({ id: "build", depends_on: ["research"] })]).errors).toEqual(["Step build depends on research, which is not in the plan."]);
  });

  test("steps that depend on each other in a loop are reported", () => {
    const result = checkPlan([step({ id: "a", depends_on: ["b"] }), step({ id: "b", depends_on: ["a"] })]);
    expect(result.errors.join(" ")).toMatch(/loop/);
  });

  test("reading an output that no step produces is reported", () => {
    expect(checkPlan([step({ id: "build", inputs: ["PRD.md"] })]).errors).toEqual(["Step build reads PRD.md, which no step produces."]);
  });

  test("reading an output from a step the reader does not depend on is reported", () => {
    const plan = [step({ id: "research", produces: ["research.md"] }), step({ id: "build", inputs: ["research.md"] })];
    expect(checkPlan(plan).errors).toEqual(["Step build reads research.md, but the step that produces it is not one it depends on."]);
  });

  test("a skipped step needs a reason, and no other step may read its output", () => {
    const skipped = checkPlan([step({ id: "research", produces: ["research.md"], skip: "" })]);
    expect(skipped.errors).toEqual(["Step research is skipped without a reason."]);
    const reads = checkPlan([
      step({ id: "research", produces: ["research.md"], skip: "the request names no product" }),
      step({ id: "build", role: "main", depends_on: ["research"], inputs: ["research.md"] }),
    ]);
    expect(reads.errors).toEqual(["Step build reads research.md from step research, which is skipped."]);
  });

  test("a skipped step that nothing reads is valid", () => {
    const plan = [step({ id: "research", produces: ["research.md"], skip: "the request names no product" }), step({ id: "build", role: "main" })];
    expect(checkPlan(plan).ok).toBe(true);
  });
});
