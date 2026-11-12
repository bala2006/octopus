import { describe, expect, it } from "vitest";
import { placeLiveHires, serialize, toNode, type AgentNode } from "@/stores/canvas";
import type { AgentOut } from "@/types";

const agent = (id: string, extra: Partial<AgentOut> = {}) =>
  ({ id, name: id, role: "Engineer", position_x: 0, position_y: 0, department: "Executive", ...extra }) as AgentOut;

const card = (id: string, x: number, y: number, department = "Executive"): AgentNode => ({
  ...toNode(agent(id, { department, position_x: x, position_y: y })),
});

const overlaps = (a: AgentNode, b: AgentNode) =>
  Math.abs(a.position.x - b.position.x) < 250 && Math.abs(a.position.y - b.position.y) < 170;

describe("placeLiveHires", () => {
  it("returns the saved nodes unchanged when nothing is hired", () => {
    const nodes = [card("ceo", 100, 40)];
    expect(placeLiveHires(nodes, [])).toBe(nodes);
  });

  it("places a new department to the right of the canvas, flagged read-only", () => {
    const nodes = [card("ceo", 100, 40)];
    const out = placeLiveHires(nodes, [agent("racer", { department: "Game Engineering" })]);
    const racer = out.find((n) => n.id === "racer")!;
    expect(racer.position.x).toBeGreaterThan(100 + 250);
    expect(racer.position.y).toBe(40);
    expect(racer.data.live_hire).toBe(true);
    expect(racer).toMatchObject({ draggable: false, selectable: false, connectable: false, deletable: false });
  });

  it("places a hire beside its own department, and never on top of another card", () => {
    const nodes = [card("ceo", 0, 0), card("eng", 0, 300, "Engineering"), card("dev", 290, 300, "Engineering")];
    const out = placeLiveHires(nodes, [agent("qa", { department: "Engineering" })]);
    const qa = out.find((n) => n.id === "qa")!;
    expect(qa.position.x).toBeGreaterThanOrEqual(290 + 250);
    for (const other of out.filter((n) => n.id !== "qa")) expect(overlaps(qa, other)).toBe(false);
  });

  it("keeps positions that were already shown during the run", () => {
    const nodes = [card("ceo", 0, 0)];
    const first = placeLiveHires(nodes, [agent("racer", { department: "Game" })]);
    const racerAt = first.find((n) => n.id === "racer")!.position;
    const again = placeLiveHires(nodes, [agent("racer", { department: "Game" }), agent("qa", { department: "Quality" })], new Map([["racer", racerAt]]));
    expect(again.find((n) => n.id === "racer")!.position).toEqual(racerAt);
  });

  it("does not duplicate agents that are already saved on the canvas", () => {
    const nodes = [card("ceo", 0, 0), card("racer", 300, 0, "Game")];
    expect(placeLiveHires(nodes, [agent("racer", { created_by: "ceo" })])).toHaveLength(2);
  });
});

describe("serialize", () => {
  it("never includes run-only hires in the saved company", () => {
    const hired = placeLiveHires([card("ceo", 0, 0)], [agent("racer", { department: "Game" })]);
    const saved = serialize(hired, []);
    expect(saved.agents.map((a) => a.id)).toEqual(["ceo"]);
  });
});
