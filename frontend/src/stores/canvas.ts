import { create } from "zustand";
import { applyEdgeChanges, applyNodeChanges, type Connection, type Edge, type EdgeChange, type Node, type NodeChange } from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { AgentIn, AgentOut, CanvasOut, EdgeConfig, EdgeIn, EdgeOut, EdgeType, RoleTemplateOut } from "@/types";
import { uid } from "@/lib/utils";

export type AgentData = Omit<AgentIn, "position_x" | "position_y"> & { id: string } & Record<string, unknown>;
export type AgentNode = Node<AgentData, "agent">;
export interface ChannelData extends Record<string, unknown> {
  type: EdgeType;
  bidirectional: boolean;
  label: string;
  config: EdgeConfig;
}
export type ChannelEdge = Edge<ChannelData, "channel">;

const EDGE_ORDER: EdgeType[] = ["delegate", "review", "debate", "report", "consult"];
const DEFAULT_CONFIG: EdgeConfig = { max_turns: 20, handoff_instructions: "", condition: "", max_rounds: 4, max_revisions: 3 };
const HISTORY_LIMIT = 100;

interface Snapshot { nodes: AgentNode[]; edges: ChannelEdge[] }

interface CanvasState {
  companyId: string | null;
  nodes: AgentNode[];
  edges: ChannelEdge[];
  past: Snapshot[];
  future: Snapshot[];
  clipboard: Snapshot | null;
  version: number; // bumps on every persisted change → autosave
  quickConfigId: string | null;
  inspectorId: string | null;
  edgeEditId: string | null;
  snapToGrid: boolean;
  load: (c: CanvasOut) => void;
  reset: () => void;
  onNodesChange: (changes: NodeChange<AgentNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<ChannelEdge>[]) => void;
  onConnect: (c: Connection) => { ok: boolean; reason?: string; edgeId?: string };
  addAgent: (tpl: Partial<RoleTemplateOut> & { role: string }, pos: { x: number; y: number }, defaults?: Partial<AgentData>) => string;
  updateAgent: (id: string, patch: Partial<AgentData>, opts?: { history?: boolean }) => void;
  setEntry: (id: string, entry: boolean) => void;
  updateEdge: (id: string, patch: Partial<ChannelData>) => { ok: boolean; reason?: string };
  deleteEdge: (id: string) => void;
  deleteNodes: (ids: string[]) => void;
  duplicate: (ids: string[]) => void;
  copy: () => number;
  paste: (at?: { x: number; y: number }) => number;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  checkpoint: () => void;
  autoLayout: (dir?: "TB" | "LR") => void;
  setQuickConfig: (id: string | null) => void;
  setInspector: (id: string | null) => void;
  setEdgeEdit: (id: string | null) => void;
  toggleSnap: () => void;
}

export function toNode(a: AgentOut | (AgentIn & { id: string })): AgentNode {
  const { position_x, position_y, ...rest } = a as AgentOut;
  const data = { ...rest } as AgentData;
  delete (data as Record<string, unknown>).company_id;
  return { id: a.id!, type: "agent", position: { x: position_x ?? 0, y: position_y ?? 0 }, data };
}

export function toEdge(e: EdgeOut | (EdgeIn & { id: string })): ChannelEdge {
  return {
    id: e.id!, source: e.source_agent_id, target: e.target_agent_id, type: "channel",
    data: { type: e.type ?? "delegate", bidirectional: !!e.bidirectional, label: e.label ?? "", config: { ...DEFAULT_CONFIG, ...(e.config ?? {}) } },
  };
}

export function serialize(nodes: AgentNode[], edges: ChannelEdge[]): { agents: AgentIn[]; edges: EdgeIn[] } {
  return {
    agents: nodes.map((n) => {
      const d = { ...n.data } as Record<string, unknown>;
      for (const k of Object.keys(d)) if (k.startsWith("_")) delete d[k];
      return { ...(d as AgentIn), id: n.id, position_x: Math.round(n.position.x), position_y: Math.round(n.position.y) };
    }),
    edges: edges.map((e) => ({
      id: e.id, source_agent_id: e.source, target_agent_id: e.target, type: e.data!.type, bidirectional: e.data!.bidirectional,
      label: e.data!.label, config: e.data!.config,
    })),
  };
}

/** Connection rules shared by UI + tests: no self loops, no duplicate channel of the same type. */
export function connectionProblem(edges: ChannelEdge[], source: string, target: string, type: EdgeType, ignoreId?: string, bidirectional = false): string | null {
  if (source === target) return "An agent cannot connect to itself";
  const dup = edges.some((e) => e.id !== ignoreId && e.data?.type === type && (
    (e.source === source && e.target === target) ||
    ((e.data?.bidirectional || bidirectional) && e.source === target && e.target === source)));
  return dup ? `These agents already have a ${type} channel` : null;
}

export const useCanvas = create<CanvasState>()((set, get) => {
  const snap = (): Snapshot => ({ nodes: get().nodes, edges: get().edges });
  const commit = (next: Partial<Pick<CanvasState, "nodes" | "edges">>, history = true) => {
    const s = get();
    set({
      ...next,
      past: history ? [...s.past, snap()].slice(-HISTORY_LIMIT) : s.past,
      future: history ? [] : s.future,
      version: s.version + 1,
    });
  };
  return {
    companyId: null, nodes: [], edges: [], past: [], future: [], clipboard: null, version: 0,
    quickConfigId: null, inspectorId: null, edgeEditId: null, snapToGrid: true,

    load: (c) => set({
      companyId: c.company.id, nodes: c.agents.map(toNode), edges: c.edges.map(toEdge), past: [], future: [], version: 0,
      quickConfigId: null, inspectorId: null, edgeEditId: null,
    }),
    reset: () => set({ companyId: null, nodes: [], edges: [], past: [], future: [], version: 0 }),

    onNodesChange: (changes) => {
      const persisted = changes.some((c) => c.type === "remove" || (c.type === "position" && c.dragging === false));
      const removed = changes.filter((c) => c.type === "remove").map((c) => (c as { id: string }).id);
      const nodes = applyNodeChanges(changes, get().nodes);
      if (removed.length) {
        const edges = get().edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target));
        commit({ nodes, edges });
        const s = get();
        if (removed.includes(s.quickConfigId ?? "")) set({ quickConfigId: null });
        if (removed.includes(s.inspectorId ?? "")) set({ inspectorId: null });
      } else if (persisted) {
        commit({ nodes }, false);
      } else set({ nodes });
    },
    onEdgesChange: (changes) => {
      const edges = applyEdgeChanges(changes, get().edges);
      if (changes.some((c) => c.type === "remove")) commit({ edges });
      else set({ edges });
    },
    onConnect: (c) => {
      if (!c.source || !c.target) return { ok: false };
      if (c.source === c.target) return { ok: false, reason: "An agent cannot connect to itself" };
      const type = EDGE_ORDER.find((t) => !connectionProblem(get().edges, c.source!, c.target!, t));
      if (!type) return { ok: false, reason: "These agents already have every channel type" };
      const id = uid();
      const edge = toEdge({ id, source_agent_id: c.source, target_agent_id: c.target, type, bidirectional: type !== "delegate" && type !== "report", label: "", config: DEFAULT_CONFIG });
      commit({ edges: [...get().edges, edge] });
      set({ edgeEditId: id });
      return { ok: true, edgeId: id };
    },
    addAgent: (tpl, pos, defaults) => {
      const id = uid();
      const n = get().nodes;
      const baseName = tpl.default_name ?? "Agent";
      const name = n.some((x) => x.data.name === baseName) ? `${baseName} ${n.filter((x) => x.data.name.startsWith(baseName)).length + 1}` : baseName;
      const node: AgentNode = {
        id, type: "agent", position: pos, selected: true,
        data: {
          id, name, role: tpl.role, description: tpl.description ?? "", avatar: tpl.avatar ?? "bot", color: tpl.color ?? "#6366f1",
          system_prompt: tpl.system_prompt ?? "", provider: "mock", model: "mock/demo", temperature: 0.4, max_tokens: 2048,
          tools: tpl.tools ?? { file_read: true, file_write: true, list_files: true, terminal: false, web_search: false, calculator: true, ask_user: false, send_message: true, mcp_servers: [] },
          behavior: { assertiveness: 0.5, creativity: 0.5, strictness: 0.5, debate_style: "balanced", max_autonomous_turns: 12, template_key: tpl.key ?? "" },
          permission_level: "inherit", is_entry: n.length === 0,
          ...defaults,
        },
      };
      commit({ nodes: [...n.map((x) => ({ ...x, selected: false })), node] });
      set({ quickConfigId: id });
      return id;
    },
    updateAgent: (id, patch, opts) => {
      commit({ nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)) }, opts?.history ?? false);
    },
    setEntry: (id, entry) => get().updateAgent(id, { is_entry: entry }, { history: true }),
    updateEdge: (id, patch) => {
      const e = get().edges.find((x) => x.id === id);
      if (!e) return { ok: false };
      const merged = { ...e.data!, ...patch, config: { ...e.data!.config, ...(patch.config ?? {}) } };
      const problem = connectionProblem(get().edges, e.source, e.target, merged.type, id, merged.bidirectional);
      if (problem) return { ok: false, reason: problem };
      commit({ edges: get().edges.map((x) => (x.id === id ? { ...x, data: merged } : x)) }, !!patch.type || patch.bidirectional !== undefined);
      return { ok: true };
    },
    deleteEdge: (id) => { commit({ edges: get().edges.filter((e) => e.id !== id) }); set({ edgeEditId: null }); },
    deleteNodes: (ids) => {
      commit({ nodes: get().nodes.filter((n) => !ids.includes(n.id)), edges: get().edges.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)) });
      set({ quickConfigId: null, inspectorId: ids.includes(get().inspectorId ?? "") ? null : get().inspectorId });
    },
    duplicate: (ids) => {
      const map = new Map<string, string>();
      const src = get().nodes.filter((n) => ids.includes(n.id));
      const clones = src.map((n) => {
        const id = uid();
        map.set(n.id, id);
        return { ...n, id, selected: true, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: { ...n.data, id, name: `${n.data.name} copy`, is_entry: false } };
      });
      const edgeClones = get().edges.filter((e) => map.has(e.source) && map.has(e.target))
        .map((e) => ({ ...e, id: uid(), source: map.get(e.source)!, target: map.get(e.target)!, selected: false }));
      commit({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...clones], edges: [...get().edges, ...edgeClones] });
    },
    copy: () => {
      const nodes = get().nodes.filter((n) => n.selected);
      const ids = new Set(nodes.map((n) => n.id));
      set({ clipboard: { nodes, edges: get().edges.filter((e) => ids.has(e.source) && ids.has(e.target)) } });
      return nodes.length;
    },
    paste: (at) => {
      const clip = get().clipboard;
      if (!clip?.nodes.length) return 0;
      const minX = Math.min(...clip.nodes.map((n) => n.position.x));
      const minY = Math.min(...clip.nodes.map((n) => n.position.y));
      const off = at ? { x: at.x - minX, y: at.y - minY } : { x: 48, y: 48 };
      const map = new Map<string, string>();
      const nodes = clip.nodes.map((n) => {
        const id = uid();
        map.set(n.id, id);
        return { ...n, id, selected: true, position: { x: n.position.x + off.x, y: n.position.y + off.y }, data: { ...n.data, id, is_entry: false } };
      });
      const edges = clip.edges.map((e) => ({ ...e, id: uid(), source: map.get(e.source)!, target: map.get(e.target)! }));
      commit({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes], edges: [...get().edges, ...edges] });
      set({ clipboard: { nodes: nodes.map((n) => ({ ...n, selected: false })), edges } });
      return nodes.length;
    },
    selectAll: () => set({ nodes: get().nodes.map((n) => ({ ...n, selected: true })) }),
    undo: () => {
      const { past, future } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      set({ ...prev, past: past.slice(0, -1), future: [snap(), ...future].slice(0, HISTORY_LIMIT), version: get().version + 1 });
    },
    redo: () => {
      const { past, future } = get();
      const next = future[0];
      if (!next) return;
      set({ ...next, past: [...past, snap()], future: future.slice(1), version: get().version + 1 });
    },
    checkpoint: () => set({ past: [...get().past, snap()].slice(-HISTORY_LIMIT), future: [] }),
    autoLayout: (dir = "TB") => {
      const g = new dagre.graphlib.Graph();
      g.setGraph({ rankdir: dir, nodesep: 60, ranksep: 110, marginx: 20, marginy: 20 });
      g.setDefaultEdgeLabel(() => ({}));
      for (const n of get().nodes) g.setNode(n.id, { width: n.measured?.width ?? 250, height: n.measured?.height ?? 130 });
      // Delegation defines the hierarchy; report edges point upward so they are reversed; others only add weak links.
      const ordered = [...get().edges].sort((a, b) => Number(b.data?.type === "delegate") - Number(a.data?.type === "delegate"));
      for (const e of ordered) {
        const [s, t] = e.data?.type === "report" ? [e.target, e.source] : [e.source, e.target];
        if (!g.hasEdge(s, t) && !g.hasEdge(t, s)) g.setEdge(s, t, { weight: e.data?.type === "delegate" ? 2 : 0.3 });
      }
      dagre.layout(g);
      commit({
        nodes: get().nodes.map((n) => {
          const p = g.node(n.id);
          return p ? { ...n, position: { x: p.x - (n.measured?.width ?? 250) / 2, y: p.y - (n.measured?.height ?? 130) / 2 } } : n;
        }),
      });
    },
    setQuickConfig: (id) => set({ quickConfigId: id, edgeEditId: id ? null : get().edgeEditId }),
    setInspector: (id) => set({ inspectorId: id, quickConfigId: null }),
    setEdgeEdit: (id) => set({ edgeEditId: id, quickConfigId: id ? null : get().quickConfigId }),
    toggleSnap: () => set({ snapToGrid: !get().snapToGrid }),
  };
});
