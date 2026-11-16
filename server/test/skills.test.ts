/** The skill catalog a solo session sees, the `skill` tool that loads one skill, and the project rules it is checked against. */
import path from "node:path";
import type { AgentOut, SkillOut } from "@octopus/shared";
import { BUILTIN_SKILLS, CATALOG_SUMMARY_CHARS, effectiveSkills, skillCatalog } from "../src/catalog/skills";
import { commandTools } from "../src/tools/commands";
import { fileTools } from "../src/tools/files";
import { openRegistry } from "../src/db/registry";
import { BUILDER_BROWSER_TOOLS } from "../src/services/mcp";
import { soloToolbox } from "../src/tools";
import { acceptanceTool, askUser, collabTools, memoryTools, plannerTools, reviewTool, workerTools } from "../src/tools/team";
import { todoTools } from "../src/tools/todo";
import { skillTool } from "../src/tools/skill";
import type { ToolContext } from "../src/tools/types";
import { webTools } from "../src/tools/web";

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

/** Every tool name the codebase defines, for any agent mode. A skill that names one of these must name one the main agent has. */
const ALL_TOOL_NAMES = new Set([
  ...fileTools, ...commandTools, ...webTools, ...memoryTools, ...collabTools, ...todoTools, ...workerTools, ...plannerTools,
  reviewTool, acceptanceTool, askUser, skillTool,
].map((t) => t.name).concat(BUILDER_BROWSER_TOOLS));

/** The names of the tools the main agent of a solo conversation has, with every switch on. */
async function mainAgentTools(): Promise<Set<string>> {
  const agent = { tools: { file_read: true, file_write: true, terminal: true, web_search: true, browser: false, mcp_servers: [] } } as unknown as AgentOut;
  const { tools } = await soloToolbox(reg, process.env.TEST_BASE_DIR!, agent);
  // The browser tools need a running browser, so the names of the builder's browser set stand in for them.
  return new Set([...tools.map((t) => t.name), ...BUILDER_BROWSER_TOOLS]);
}

/** A name that is a tool: one the codebase defines, or a browser tool the Playwright server adds. */
const isToolName = (name: string) => ALL_TOOL_NAMES.has(name) || name.startsWith("browser_");

/** The lowercase identifiers a skill writes in backticks, such as `write_file`. */
const backticked = (text: string) => [...text.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]!);

describe("the shipped skills", () => {
  test("name only tools the main agent has", async () => {
    const mine = await mainAgentTools();
    const named = BUILTIN_SKILLS.flatMap((s) => [...backticked(s.description), ...backticked(s.body)].filter((n) => isToolName(n) && !mine.has(n)).map((n) => `${s.name} names ${n}`));
    expect(named).toEqual([]);
  });
});