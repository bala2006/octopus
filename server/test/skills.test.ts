/** The skill catalog a solo session sees, the `skill` tool that loads one skill, and the project rules it is checked against. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { RULES_BYTES, rulesUpdate } from "../src/workspace/instructions";

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

describe("the project rules", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(path.join(process.env.TEST_BASE_DIR!, "rules-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const put = (name: string, text: string) => writeFileSync(path.join(root, name), text);

  test("the first message holds each rules file present, in list order, and no other file", () => {
    put("CLAUDE.local.md", "Local claude rule.");
    put("AGENTS.md", "Use pnpm.");
    put("README.md", "Not a rules file.");
    const first = rulesUpdate(root, {})!;
    expect(first.message.startsWith("<project-rules>\n")).toBe(true);
    expect(first.message.indexOf("## AGENTS.md")).toBeLessThan(first.message.indexOf("## CLAUDE.local.md"));
    expect(first.message).toContain("Use pnpm.");
    expect(first.message).toContain("Local claude rule.");
    expect(first.message).not.toContain("Not a rules file.");
    expect(Object.keys(first.sent).sort()).toEqual(["AGENTS.md", "CLAUDE.local.md"]);
  });

  test("nothing is sent again while the files stay as they were", () => {
    put("AGENTS.md", "Use pnpm.");
    const first = rulesUpdate(root, {})!;
    expect(rulesUpdate(root, first.sent)).toBeNull();
  });

  test("a changed file gets a new message with its new text, and the other files are not repeated", () => {
    put("AGENTS.md", "Use pnpm.");
    put("CLAUDE.md", "Be brief.");
    const first = rulesUpdate(root, {})!;
    put("AGENTS.md", "Use npm.");
    const next = rulesUpdate(root, first.sent)!;
    expect(next.message).toContain("Use npm.");
    expect(next.message).not.toContain("Be brief.");
    expect(next.message).not.toContain("Use pnpm.");
    expect(rulesUpdate(root, next.sent)).toBeNull();
  });

  test("a removed file gets a note that the version sent earlier no longer applies", () => {
    put("AGENTS.md", "Use pnpm.");
    const first = rulesUpdate(root, {})!;
    rmSync(path.join(root, "AGENTS.md"));
    const next = rulesUpdate(root, first.sent)!;
    expect(next.message).toContain("## AGENTS.md\n(Removed from the project. Ignore the version sent earlier.)");
    expect(next.sent).toEqual({});
  });

  test("a 100 KB file is cut at 64 KB, and the message says so", () => {
    put("AGENTS.md", "x".repeat(100 * 1024));
    const { message } = rulesUpdate(root, {})!;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(RULES_BYTES + 200);
    expect(message).toContain("Cut at 64 KB. The rest of this file is not shown.");
  });

  test("the first message holds 64 KB in all across the files, in list order", () => {
    put("AGENTS.md", "q".repeat(40 * 1024));
    put("CLAUDE.md", "z".repeat(40 * 1024));
    const { message } = rulesUpdate(root, {})!;
    expect(message.split("q").length - 1).toBe(40 * 1024);
    expect(message.split("z").length - 1).toBe(RULES_BYTES - 40 * 1024);
    expect(message).toContain("Cut at 64 KB");
  });

  test("a cut never splits a character", () => {
    put("AGENTS.md", `a${"é".repeat(40 * 1024)}`);
    const { message } = rulesUpdate(root, {})!;
    expect(message).not.toContain("\uFFFD");
    expect(message).toContain("Cut at 64 KB");
  });
});