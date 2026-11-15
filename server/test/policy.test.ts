/** Phase 1 of one writer: a role's kind decides what it may write and run, and staffing keeps one writer per part. */
import type { AgentOut, AgentTools } from "@octopus/shared";
import type { Registry } from "../src/db/registry";
import { kindOf, staffingError } from "../src/catalog/kinds";
import { policyFor, toolbox } from "../src/tools/index";

const TOOLS: AgentTools = {
  file_read: true, list_files: true, file_write: true, terminal: true, browser: false, web_search: false,
  calculator: true, ask_user: true, send_message: true, manage_team: false, mcp_servers: [],
};

function member(key: string, tools: Partial<AgentTools> = {}, over: Partial<AgentOut> = {}): AgentOut {
  return { id: `id-${key}`, name: key, role: key, behavior: { template_key: key }, is_manager: false, tools: { ...TOOLS, ...tools }, ...over } as unknown as AgentOut;
}

const WRITE_AND_RUN = ["write_file", "edit_file", "delete_file", "run_command"];

describe("kindOf", () => {
  test("built-in roles keep one kind whatever their switches say", () => {
    expect(kindOf(member("developer"))).toBe("writer");
    expect(kindOf(member("qa"))).toBe("critic");
    expect(kindOf(member("designer", { file_write: true }))).toBe("critic");
    expect(kindOf(member("orchestrator", {}, { is_manager: true }))).toBe("lead");
  });

  test("a custom role keeps the meaning of its file-write switch", () => {
    expect(kindOf(member("custom-engineer", { file_write: true }))).toBe("writer");
    expect(kindOf(member("custom-reviewer", { file_write: false }))).toBe("critic");
  });
});

describe("policyFor", () => {
  test("a writer in a build turn may write files and run commands", () => {
    expect(policyFor(member("developer"), "worker")).toEqual({ files: true, commands: "all", browser: false, mcp: true });
  });

  test("a critic in review may not write, run commands or use MCP, but may browse", () => {
    expect(policyFor(member("qa", { browser: true }), "reviewer")).toEqual({ files: false, commands: "none", browser: true, mcp: false });
  });

  test("a critic in acceptance may start the app and nothing else", () => {
    expect(policyFor(member("qa"), "acceptance")).toMatchObject({ files: false, commands: "start" });
  });

  test("a writer outside a build turn writes nothing", () => {
    expect(policyFor(member("developer"), "chat")).toMatchObject({ files: false, commands: "none" });
    expect(policyFor(member("developer"), "reviewer")).toMatchObject({ files: false, commands: "none" });
  });

  test("the lead plans and never writes", () => {
    expect(policyFor(member("orchestrator", {}, { is_manager: true }), "orchestrator")).toMatchObject({ files: false, commands: "none" });
  });
});

describe("staffingError", () => {
  test("a critic cannot own a part", () => {
    expect(staffingError(member("qa"), [])).toMatch(/not a writer/);
  });

  test("a specialist that writes cannot critique a part", () => {
    expect(staffingError(member("developer"), [member("frontend")])).toMatch(/writes files/);
  });

  test("the owner cannot also critique its own part", () => {
    const alex = member("developer");
    expect(staffingError(alex, [alex])).toMatch(/owns this part/);
  });

  test("one writer and critics that only read is valid", () => {
    expect(staffingError(member("developer"), [member("qa"), member("designer")])).toBeNull();
  });
});

describe("toolbox names", () => {
  test("a critic in review gets read and report tools, never a write or a command", async () => {
    const { tools } = await toolbox({} as Registry, ".", member("qa", { browser: false }), "reviewer");
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "search_project", "submit_review"]));
    for (const forbidden of WRITE_AND_RUN) expect(names).not.toContain(forbidden);
  });

  test("a critic in acceptance can start the app but not run other commands", async () => {
    const { tools } = await toolbox({} as Registry, ".", member("qa", { browser: false }), "acceptance");
    const names = tools.map((t) => t.name);
    expect(names).toContain("start_dev_server");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("write_file");
  });

  test("the writer in a build turn gets the write and command tools", async () => {
    const { tools } = await toolbox({} as Registry, ".", member("developer", { browser: false }), "worker");
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["write_file", "edit_file", "run_command"]));
  });
});
