import { describe, expect, it } from "vitest";
import { splitWork } from "./files";

describe("splitWork", () => {
  const files = [
    { path: "index.html", area: "project" },
    { path: ".octopus/work/qa/test_plan.md", area: "work" },
    { path: "src/main.js", area: "project" },
  ];

  it("separates the deliverables from the agents' working documents in the project view", () => {
    const [project, work] = splitWork(files, true);
    expect(project.map((f) => f.path)).toEqual(["index.html", "src/main.js"]);
    expect(work.map((f) => f.path)).toEqual([".octopus/work/qa/test_plan.md"]);
  });

  it("recognises working docs by path when the API gives no area (run artifacts)", () => {
    const [, work] = splitWork([{ path: ".octopus/work/brief.md" }, { path: "README.md" }], true);
    expect(work).toEqual([{ path: ".octopus/work/brief.md" }]);
  });

  it("leaves the run view untouched", () => {
    expect(splitWork(files, false)).toEqual([files, []]);
  });
});
