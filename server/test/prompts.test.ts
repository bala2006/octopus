/** Phase 3 of one writer: prompts are short and role-specific, and no critic is told to write. */
import type { AgentOut } from "@octopus/shared";
import { kindOf } from "../src/catalog/kinds";
import { BUILTIN_ROLES } from "../src/catalog/roles";
import { BUILTIN_SKILLS } from "../src/catalog/skills";
import { instructions, lensOf } from "../src/engine/prompts";

function member(key: string, over: Record<string, unknown> = {}): AgentOut {
  const role = BUILTIN_ROLES.find((r) => r.key === key)!;
  return {
    id: key, name: key, role: role.role, department: "Engineering", is_manager: false,
    behavior: { template_key: key, skills: [] }, system_prompt: role.system_prompt, tools: role.tools, active: true, ...over,
  } as unknown as AgentOut;
}

function promptFor(agent: AgentOut, mode: Parameters<typeof instructions>[1]): string {
  return instructions({ agent, company: "Acme", goal: "Build a hello page.", team: [agent], overview: "", memory: { own: [], shared: [] }, skills: [] } as unknown as Parameters<typeof instructions>[0], mode);
}

describe("system prompts", () => {
  test("a writer is told it is the one writer, and how to answer findings", () => {
    const text = promptFor(member("developer"), "worker");
    expect(text).toContain("You are the one writer for this part");
    expect(text).toContain("fixed (what you changed) or disputed (why it is wrong)");
    expect(text).not.toContain("## Standards");
  });

  test("the lead does not get the writer's standards", () => {
    expect(promptFor(member("orchestrator", { is_manager: true }), "orchestrator")).not.toContain("You are the one writer");
  });

  test("every built-in critic reads and reports, and none is told or allowed to write", () => {
    const critics = BUILTIN_ROLES.filter((r) => kindOf({ behavior: { template_key: r.key }, tools: r.tools, is_manager: false } as unknown as AgentOut) === "critic");
    expect(critics.length).toBeGreaterThan(3);
    for (const r of critics) {
      expect(r.system_prompt, r.key).not.toMatch(/\.octopus\/work|\bwrite (it|the|a|specs?|automated)\b|define what owners/i);
      expect(r.tools.file_write, r.key).not.toBe(true);
    }
  });
});

describe("shipped playbooks", () => {
  test("the game playbook does not contradict a one-file brief or the user's no-CDN rule", () => {
    const game = BUILTIN_SKILLS.find((s) => s.name === "web-game")!;
    expect(game.body).not.toContain("window.__game");
    expect(game.body).not.toContain("pinned CDN import map.");
    expect(game.body).not.toContain("No file over");
  });
});

describe("specialist roster", () => {
  test("the code quality reviewer and the duplication checker are critics with their own lenses", () => {
    expect(kindOf(member("codequality"))).toBe("critic");
    expect(kindOf(member("duplication"))).toBe("critic");
    expect(lensOf(member("codequality"))).toBe("code");
    expect(lensOf(member("duplication"))).toBe("duplication");
  });
});