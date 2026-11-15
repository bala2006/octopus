/** Every shipped team can do the work it advertises: someone writes, reviewers can read, verifiers can run the product. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentOut } from "@octopus/shared";
import { BUILTIN_TEMPLATES, buildTemplate } from "../src/catalog/templates";
import { BUILTIN_ROLES } from "../src/catalog/roles";
import { canReview, canVerify, canWrite, kindOf, staffingError } from "../src/catalog/kinds";
import { openRegistry } from "../src/db/registry";

const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "kinds-")), "registry.db"));

const asAgent = (over: Record<string, unknown>): AgentOut => ({
  id: "a", name: "Someone", role: "Role", department: "Engineering", is_manager: false, reports_to: null, active: true,
  behavior: { template_key: "", skills: [] }, tools: { file_read: true, file_write: true }, ...over,
} as unknown as AgentOut);

describe("capability, not rank", () => {
  test("a department lead who builds can own a part", () => {
    const lead = asAgent({ is_manager: true, behavior: { template_key: "frontend" }, tools: { file_read: true, file_write: true, terminal: true } });
    expect(kindOf(lead)).toBe("writer");
    expect(canWrite(lead)).toBe(true);
    expect(staffingError(lead, [])).toBeNull();
  });

  test("a department lead who reviews can be a specialist and a verifier", () => {
    const qa = asAgent({ is_manager: true, behavior: { template_key: "qa" }, tools: { file_read: true, file_write: false, terminal: true, browser: true } });
    expect(kindOf(qa)).toBe("critic");
    expect(canReview(qa)).toBe(true);
    expect(canVerify(qa)).toBe(true);
  });

  test("the lead roles plan and review, and never own a part", () => {
    for (const key of ["orchestrator", "ceo", "pm"]) {
      const role = BUILTIN_ROLES.find((r) => r.key === key)!;
      const agent = asAgent({ is_manager: true, behavior: { template_key: key }, tools: role.tools });
      expect(kindOf(agent), key).toBe("lead");
      expect(canWrite(agent), key).toBe(false);
      expect(staffingError(agent, []), key).toContain("cannot own a part");
    }
  });

  test("a writer cannot be attached as a specialist, and a reviewer cannot own a part", () => {
    const writer = asAgent({ id: "w", name: "Lena", behavior: { template_key: "frontend" } });
    const reviewer = asAgent({ id: "r", name: "Kai", behavior: { template_key: "techlead" }, tools: { file_read: true, file_write: false } });
    expect(staffingError(writer, [reviewer])).toBeNull();
    expect(staffingError(writer, [writer])).toContain("owns this part");
    expect(staffingError(writer, [asAgent({ id: "x", name: "Diego", behavior: { template_key: "backend" } })])).toContain("writes files");
    expect(staffingError(reviewer, [])).toContain("cannot own a part");
    expect(canReview(writer)).toBe(false);
  });

  test("an agent that cannot read the project cannot review it", () => {
    const blind = asAgent({ id: "blind", name: "Blind", tools: { file_read: false, file_write: false, terminal: true } });
    expect(canReview(blind)).toBe(false);
    expect(canVerify(blind)).toBe(false);
    expect(staffingError(asAgent({ id: "owner", name: "Lena" }), [blind])).toContain("cannot read the project");
  });
});

describe("shipped templates", () => {
  for (const t of BUILTIN_TEMPLATES) {
    test(`${t.key} can start its intended work`, () => {
      const { agents } = buildTemplate(reg, t.key, `company-${t.key}`);
      const writers = agents.filter(canWrite);
      const reviewers = agents.filter(canReview);
      const verifiers = agents.filter(canVerify);
      // The self-organizing template starts with the lead alone and hires a writer per request; every other template
      // ships with its writers.
      if (t.departments.length) expect(writers.length, `${t.key} has no writer`).toBeGreaterThan(0);
      // Every agent whose role is a reviewing one must actually be able to review, whatever its rank.
      for (const a of agents) {
        const key = a.behavior.template_key ?? "";
        if (["techlead", "codequality", "duplication", "qa", "security", "designer", "architect"].includes(key)) {
          expect(canReview(a), `${t.key}: ${a.name} (${a.role}) cannot review`).toBe(true);
        }
      }
      // A template that seeds a QA or a browser-capable reviewer must be able to run an acceptance check.
      if (agents.some((a) => (a.behavior.template_key ?? "") === "qa")) expect(verifiers.length, `${t.key} has no verifier`).toBeGreaterThan(0);
      // A template with writers and no critic is completed by the engine hiring a reviewer (see reviewerFor); the
      // self-organizing template hires both per request.
      if (t.departments.length && !reviewers.length) expect(writers.length, `${t.key} has neither a reviewer nor a writer`).toBeGreaterThan(0);
    });
  }

  test("a department lead can be assigned the work it builds", () => {
    const { agents } = buildTemplate(reg, "solo_engineer", "company-solo");
    const dev = agents.find((a) => a.is_manager && canWrite(a))!;
    expect(dev, "solo engineer has no writer").toBeDefined();
    expect(staffingError(dev, [])).toBeNull();
  });
});
