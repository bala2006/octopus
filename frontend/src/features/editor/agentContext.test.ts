import { describe, expect, it } from "vitest";
import { contextGoal } from "./agentContext";

describe("agent editor context", () => {
  it("keeps instructions and explicitly identified unsaved selection context", () => {
    const goal = contextGoal("Explain this function", [
      {
        path: "src/app.ts",
        content: "return 42;",
        startLine: 5,
        endLine: 5,
        dirty: true,
      },
    ]);
    expect(goal).toContain("Explain this function");
    expect(goal).toContain("src/app.ts:5-5 (unsaved editor snapshot)");
    expect(goal).toContain("return 42;");
    expect(goal).toContain("not changes on disk");
  });
  it("bounds a large set of attachments to the API's message limit and marks truncation", () => {
    const goal = contextGoal(
      "x".repeat(8000),
      Array.from({ length: 8 }, (_, i) => ({
        path: `src/${i}.ts`,
        content: "x".repeat(100000),
      })),
    );
    expect(goal.length).toBeLessThanOrEqual(20000);
    expect(goal).toContain("Context truncated");
    expect(contextGoal("  Fix a bug  ", [])).toBe("Fix a bug");
  });
});
