import { describe, expect, it } from "vitest";
import { withLiveHires } from "./liveHires";
import { toNode } from "@/stores/canvas";
import type { AgentOut } from "@/types";

const agent = (id: string, extra: Partial<AgentOut> = {}) =>
  ({
    id,
    name: id,
    role: "Engineer",
    position_x: 0,
    position_y: 0,
    ...extra,
  }) as AgentOut;

describe("withLiveHires", () => {
  it("returns the saved nodes unchanged when nothing is hired", () => {
    const nodes = [toNode(agent("ceo", { position_x: 10, position_y: 20 }))];
    expect(withLiveHires(nodes, [])).toBe(nodes);
  });

  it("shows hired agents read-only, below the agent that hired them", () => {
    const nodes = [toNode(agent("ceo", { position_x: 100, position_y: 40 }))];
    const out = withLiveHires(nodes, [
      agent("racer", { created_by: "ceo" }),
      agent("qa", { created_by: "ceo" }),
    ]);
    expect(out.map((n) => n.id)).toEqual(["ceo", "racer", "qa"]);
    expect(out[1].position).toEqual({ x: 100, y: 260 });
    expect(out[2].position).toEqual({ x: 360, y: 260 });
    expect(out[1]).toMatchObject({
      draggable: false,
      selectable: false,
      connectable: false,
      className: "live-hire",
    });
  });

  it("does not duplicate agents that are already saved on the canvas", () => {
    const nodes = [toNode(agent("ceo")), toNode(agent("racer"))];
    expect(
      withLiveHires(nodes, [agent("racer", { created_by: "ceo" })]),
    ).toHaveLength(2);
  });

  it("places an agent with an unknown creator below the existing graph", () => {
    const nodes = [toNode(agent("ceo", { position_x: 0, position_y: 300 }))];
    const out = withLiveHires(nodes, [
      agent("ghost", { created_by: "missing" }),
    ]);
    expect(out[1].position).toEqual({ x: 0, y: 520 });
  });
});
