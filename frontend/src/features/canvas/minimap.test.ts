import { describe, expect, it } from "vitest";
import { initials, minimapSummary, presentStatuses } from "./CanvasMiniMap";
import type { AgentNode } from "@/stores/canvas";

const node = (id: string, name: string) => ({ id, data: { name } }) as unknown as Pick<AgentNode, "id" | "data">;

describe("minimap", () => {
  it("labels agents with readable initials", () => {
    expect(initials("Riley Chen")).toBe("RC");
    expect(initials("Alex de la Morgan")).toBe("AM");
    expect(initials("Sam")).toBe("SA");
    expect(initials("")).toBe("?");
  });

  it("builds the legend from the statuses actually present", () => {
    const status = { a: "thinking", b: "error", c: "thinking" };
    expect(presentStatuses(["a", "b", "c", "d"], status)).toEqual(["idle", "thinking", "error"]);
    expect(presentStatuses(["a"], undefined)).toEqual([]);
  });

  it("describes the live team for assistive tech", () => {
    const nodes = [node("a", "Ann"), node("b", "Ben"), node("c", "Cy")];
    expect(minimapSummary(nodes, null)).toBe("Minimap of 3 agents. Click an agent to select and center it.");
    expect(minimapSummary(nodes, { status: { a: "thinking", b: "error" } })).toBe(
      "Minimap of 3 agents: 1 thinking, 1 error, 1 idle. Click an agent to select and center it.");
  });
});
