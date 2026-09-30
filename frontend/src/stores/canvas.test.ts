import { beforeEach, describe, expect, it } from "vitest";
import { connectionProblem, serialize, useCanvas } from "./canvas";

const tpl = { role: "Engineer", default_name: "Eve", color: "#8b5cf6", avatar: "code", key: "developer" };

describe("canvas store", () => {
  beforeEach(() => useCanvas.getState().reset());

  it("adds agents, first one becomes entry, connects with rules", () => {
    const s = useCanvas.getState();
    const a = s.addAgent(tpl, { x: 0, y: 0 });
    const b = useCanvas.getState().addAgent(tpl, { x: 300, y: 0 });
    expect(useCanvas.getState().nodes.find((n) => n.id === a)?.data.is_entry).toBe(true);
    expect(useCanvas.getState().nodes.find((n) => n.id === b)?.data.name).toBe("Eve 2");
    expect(useCanvas.getState().onConnect({ source: a, target: a, sourceHandle: null, targetHandle: null }).ok).toBe(false);
    const r1 = useCanvas.getState().onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    const r2 = useCanvas.getState().onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    const types = useCanvas.getState().edges.map((e) => e.data?.type);
    expect(r1.ok && r2.ok).toBe(true);
    expect(types).toEqual(["delegate", "review"]); // no duplicate of the same type
    expect(connectionProblem(useCanvas.getState().edges, a, b, "delegate")).toMatch(/already/);
  });

  it("undo / redo and copy / paste", () => {
    const a = useCanvas.getState().addAgent(tpl, { x: 0, y: 0 });
    useCanvas.getState().updateAgent(a, { name: "Renamed" }, { history: true });
    useCanvas.getState().undo();
    expect(useCanvas.getState().nodes[0].data.name).toBe("Eve");
    useCanvas.getState().redo();
    expect(useCanvas.getState().nodes[0].data.name).toBe("Renamed");
    useCanvas.getState().selectAll();
    expect(useCanvas.getState().copy()).toBe(1);
    expect(useCanvas.getState().paste()).toBe(1);
    const nodes = useCanvas.getState().nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1].data.is_entry).toBe(false);
    const out = serialize(nodes, useCanvas.getState().edges);
    expect(out.agents[1].position_x).toBe(48);
  });

  it("deleting a node removes its edges", () => {
    const a = useCanvas.getState().addAgent(tpl, { x: 0, y: 0 });
    const b = useCanvas.getState().addAgent(tpl, { x: 0, y: 0 });
    useCanvas.getState().onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    useCanvas.getState().deleteNodes([b]);
    expect(useCanvas.getState().edges).toHaveLength(0);
  });
});
