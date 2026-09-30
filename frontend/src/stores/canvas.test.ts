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

describe("departments", () => {
  beforeEach(() => useCanvas.getState().reset());
  const role = (key: string, name: string) => ({
    key, role: key, default_name: name, color: "#8b5cf6", avatar: "code", description: "", system_prompt: "p",
    tools: { file_read: true, file_write: true, list_files: true, terminal: false, web_search: false, calculator: true, ask_user: false, send_message: true, manage_team: false, mcp_servers: [] },
  });

  it("adds a department with a manager, members and wired channels", () => {
    const head = useCanvas.getState().addAgent({ ...tpl, role: "CEO" }, { x: 0, y: 0 });
    useCanvas.getState().updateAgent(head, { is_manager: true });
    const ids = useCanvas.getState().addDepartment({
      name: "Engineering", color: "#10b981", reportsTo: head, at: { x: 0, y: 300 },
      manager: { role: role("eng_manager", "Omar") }, members: [{ role: role("dev", "Leo") }, { role: role("dev", "Leo") }],
    });
    const nodes = useCanvas.getState().nodes;
    const mgr = nodes.find((n) => n.id === ids[0])!;
    expect(mgr.data.is_manager).toBe(true);
    expect(mgr.data.tools?.manage_team).toBe(true);
    expect(mgr.data.reports_to).toBe(head);
    const members = nodes.filter((n) => ids.slice(1).includes(n.id));
    expect(members.map((m) => m.data.name)).toEqual(["Leo", "Leo 2"]);
    expect(members.every((m) => m.data.reports_to === mgr.id && m.data.department === "Engineering")).toBe(true);
    const e = useCanvas.getState().edges.map((x) => `${x.source === mgr.id ? "M" : x.source === head ? "H" : "m"}-${x.data?.type}`);
    expect(e.filter((x) => x === "M-delegate")).toHaveLength(2);
    expect(e).toContain("H-delegate");
    expect(useCanvas.getState().departments.Engineering.color).toBe("#10b981");
  });

  it("renames a department across its agents (undoable)", () => {
    useCanvas.getState().addDepartment({ name: "Eng", color: "#10b981", reportsTo: null, at: { x: 0, y: 0 }, manager: { role: role("m", "Omar") }, members: [{ role: role("d", "Leo") }] });
    useCanvas.getState().renameDepartment("Eng", "Engineering");
    expect(useCanvas.getState().nodes.every((n) => n.data.department === "Engineering")).toBe(true);
    expect(useCanvas.getState().departments.Engineering).toBeTruthy();
    useCanvas.getState().undo();
    expect(useCanvas.getState().nodes.every((n) => n.data.department === "Eng")).toBe(true);
  });
});
