/** The skill catalog a solo session sees, the `skill` tool that loads one skill, and the project rules it is checked against. */
import path from "node:path";
import type { SkillOut } from "@octopus/shared";
import { BUILTIN_SKILLS, CATALOG_SUMMARY_CHARS, effectiveSkills, skillCatalog } from "../src/catalog/skills";
import { openRegistry } from "../src/db/registry";
import { skillTool } from "../src/tools/skill";
import type { ToolContext } from "../src/tools/types";

const reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry.db"));

const skill = (over: Partial<SkillOut>): SkillOut => ({ name: "sample", description: "A sample skill.", body: "# Sample", roles: [], phases: [], source: "custom", ...over });

describe("the skill catalog", () => {
  test("lists each skill as a backticked name and its description, under the skills tag", () => {
    const catalog = skillCatalog([skill({ name: "alpha", description: "First." }), skill({ name: "beta", description: "Second." })]);
    expect(catalog.split("\n")).toEqual([
      "<skills>",
      "A skill is a set of instructions for one kind of task. These skills are available in this session:",
      "- `alpha`: First.",
      "- `beta`: Second.",
      "If the user names a skill, or the task clearly matches one, call skill with its exact name before you start, then follow it. This list holds summaries only. Do not follow a skill until you have loaded it.",
      "</skills>",
    ]);
  });

  test("cuts each description at 500 characters and keeps the rest of the line", () => {
    const long = `${"a".repeat(499)}bc`;
    const catalog = skillCatalog([skill({ name: "long", description: long })]);
    const line = catalog.split("\n").find((l) => l.startsWith("- `long`: "))!;
    expect(line).toBe(`- \`long\`: ${"a".repeat(499)}b`);
    expect(line.slice("- `long`: ".length)).toHaveLength(CATALOG_SUMMARY_CHARS);
  });

  test("counts characters, not UTF-16 units, when it cuts", () => {
    const catalog = skillCatalog([skill({ name: "emoji", description: "😀".repeat(501) })]);
    const summary = catalog.split("\n").find((l) => l.startsWith("- `emoji`: "))!.slice("- `emoji`: ".length);
    expect(Array.from(summary)).toHaveLength(CATALOG_SUMMARY_CHARS);
  });

  test("folds line breaks in a description into spaces, so each skill takes one line", () => {
    const catalog = skillCatalog([skill({ name: "multi", description: "Line one.\n\nLine two." })]);
    expect(catalog).toContain("- `multi`: Line one. Line two.\n");
  });

  test("is empty when there are no skills, so the session sends nothing", () => {
    expect(skillCatalog([])).toBe("");
  });

  test("lists every built-in skill and every custom skill from Settings", () => {
    const catalog = skillCatalog([...effectiveSkills(reg), skill({ name: "house-style", description: "Our copy rules." })]);
    for (const s of BUILTIN_SKILLS) expect(catalog).toContain(`- \`${s.name}\`: `);
    expect(catalog).toContain("- `house-style`: Our copy rules.");
  });
});

describe("the skill tool", () => {
  const call = (name: string) => skillTool.run({ reg } as unknown as ToolContext, { name }, "call-1");

  test("returns the body of the skill with that exact name as the result", async () => {
    const web = BUILTIN_SKILLS.find((s) => s.name === "web-game")!;
    const result = await call("web-game");
    expect(result.text).toBe(web.body);
    expect(result.ok).toBeUndefined();
  });

  test("refuses a name that is not in the list, and does not match case-insensitively", async () => {
    for (const name of ["no-such-skill", "Web-Game"]) {
      const result = await call(name);
      expect(result.ok).toBe(false);
      expect(result.text).toContain(`No skill named ${name}`);
    }
  });
});
