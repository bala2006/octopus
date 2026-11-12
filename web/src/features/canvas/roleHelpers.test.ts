import { describe, expect, it } from "vitest";
import type { RoleTemplateOut } from "@/types";
import type { AgentData } from "@/stores/canvas";
import { applyRole, isLinked, presetOf, roleOptions, TOOL_PRESETS } from "./roleHelpers";
import { groupRoles } from "@/features/settings/RolesSection";

const tools = { file_read: true, file_write: true, list_files: true, terminal: true, web_search: false, calculator: true, ask_user: false,
  send_message: true, manage_team: false, browser: true, mcp_servers: [] as string[] };
const qa: RoleTemplateOut = { key: "qa", role: "QA Engineer", default_name: "Quinn", color: "#ef4444", avatar: "bug", description: "Tests",
  system_prompt: "QA prompt", tools, category: "Quality", source: "builtin" };
const ceo: RoleTemplateOut = { ...qa, key: "ceo", role: "CEO", category: "Leadership", system_prompt: "CEO prompt" };
const agent = (over: Partial<AgentData> = {}) => ({ id: "a", name: "Ann", role: "Dev", system_prompt: "x", is_manager: true,
  tools: { ...tools, mcp_servers: ["srv1"], manage_team: true }, behavior: { template_key: "", reasoning_effort: "high" }, ...over }) as unknown as AgentData;

describe("roles on the canvas", () => {
  it("lists roles grouped by category, leadership first", () => {
    expect(groupRoles([qa, ceo]).map(([c]) => c)).toEqual(["Leadership", "Quality"]);
    expect(roleOptions([qa, ceo]).map((o) => [o.group, o.label])).toEqual([["Leadership", "CEO"], ["Quality", "QA Engineer"]]);
  });
  it("picking a role links its prompt and keeps manager rights, MCP grants and other behaviour", () => {
    const p = applyRole(agent(), qa);
    expect(p.role).toBe("QA Engineer");
    expect(p.system_prompt).toBe("QA prompt");
    expect(p.behavior).toMatchObject({ template_key: "qa", prompt_linked: true, reasoning_effort: "high" });
    expect(p.tools).toMatchObject({ mcp_servers: ["srv1"], manage_team: true, terminal: true });
  });
  it("knows when an agent follows its role prompt", () => {
    expect(isLinked(agent({ behavior: { template_key: "qa", prompt_linked: true } as AgentData["behavior"] }), [qa])).toBe(true);
    expect(isLinked(agent({ system_prompt: "QA prompt", behavior: { template_key: "qa" } as AgentData["behavior"] }), [qa])).toBe(true);
    expect(isLinked(agent({ system_prompt: "mine", behavior: { template_key: "qa" } as AgentData["behavior"] }), [qa])).toBe(false);
    expect(isLinked(agent({ behavior: { template_key: "qa", prompt_linked: false } as AgentData["behavior"] }), [qa])).toBe(false);
  });
  it("recognises tool presets", () => {
    expect(presetOf(tools as never, qa)).toBe("role");
    const reviewer = TOOL_PRESETS.find((p) => p.value === "reviewer")!.tools;
    expect(presetOf({ ...tools, ...reviewer } as never)).toBe("reviewer");
    expect(presetOf({ ...tools, ask_user: true, web_search: true } as never)).toBe("custom");
  });
});
