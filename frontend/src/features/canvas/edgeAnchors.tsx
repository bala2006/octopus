import * as React from "react";
import { Position, useEdges, useNodes } from "@xyflow/react";
import type { AgentNode, ChannelEdge } from "@/stores/canvas";

/**
 * Floating edge anchors.
 *
 * Every channel is attached to the side of the agent card that faces its partner:
 *  - different levels → the higher agent's BOTTOM connects to the lower agent's TOP
 *  - same level        → the left agent's RIGHT connects to the right agent's LEFT
 * Several channels on one side are spread out along it (sorted by partner position, so lines don't cross),
 * which also separates delegate/report pairs between the same two agents.
 */
export interface Anchor { sx: number; sy: number; tx: number; ty: number; sPos: Position; tPos: Position }
type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number };

const DEFAULT_W = 250;
const DEFAULT_H = 130;
const SAME_LEVEL_GAP = 40; // vertical gap (px) under which two agents count as "same level"
const MAX_SPACING = 26;
const SIDE_MARGIN = 22;

export const AnchorsContext = React.createContext<Map<string, Anchor> | null>(null);
export const useAnchor = (id: string) => React.useContext(AnchorsContext)?.get(id);

function box(n: AgentNode): Box {
  const w = n.measured?.width ?? n.width ?? DEFAULT_W;
  const h = n.measured?.height ?? n.height ?? DEFAULT_H;
  return { x: n.position.x, y: n.position.y, w, h, cx: n.position.x + w / 2, cy: n.position.y + h / 2 };
}

export function computeAnchors(nodes: AgentNode[], edges: ChannelEdge[]): Map<string, Anchor> {
  const boxes = new Map(nodes.map((n) => [n.id, box(n)]));
  // node:side → endpoints attached there
  const slots = new Map<string, { edgeId: string; end: "s" | "t"; key: number }[]>();
  const sides = new Map<string, { s: Position; t: Position }>();
  const push = (nodeId: string, side: Position, edgeId: string, end: "s" | "t", key: number) => {
    const k = `${nodeId}:${side}`;
    const list = slots.get(k) ?? [];
    list.push({ edgeId, end, key });
    slots.set(k, list);
  };

  for (const e of edges) {
    const a = boxes.get(e.source), b = boxes.get(e.target);
    if (!a || !b || e.source === e.target) continue;
    const vGap = Math.abs(b.cy - a.cy) - (a.h + b.h) / 2;
    let s: Position, t: Position;
    if (vGap > SAME_LEVEL_GAP || (vGap > -a.h / 2 && Math.abs(b.cx - a.cx) < (a.w + b.w) / 2)) {
      // different levels (or stacked): bottom of the higher agent → top of the lower one
      const sourceHigher = a.cy <= b.cy;
      s = sourceHigher ? Position.Bottom : Position.Top;
      t = sourceHigher ? Position.Top : Position.Bottom;
      push(e.source, s, e.id, "s", b.cx);
      push(e.target, t, e.id, "t", a.cx);
    } else {
      // same level: facing left/right sides
      const sourceLeft = a.cx <= b.cx;
      s = sourceLeft ? Position.Right : Position.Left;
      t = sourceLeft ? Position.Left : Position.Right;
      push(e.source, s, e.id, "s", b.cy);
      push(e.target, t, e.id, "t", a.cy);
    }
    sides.set(e.id, { s, t });
  }

  const points = new Map<string, { x: number; y: number }>(); // `${edgeId}:${end}` → point
  for (const [k, list] of slots) {
    const idx = k.lastIndexOf(":");
    const nodeId = k.slice(0, idx);
    const side = k.slice(idx + 1) as Position;
    const bx = boxes.get(nodeId)!;
    const horizontalSide = side === Position.Top || side === Position.Bottom;
    const len = horizontalSide ? bx.w : bx.h;
    // pair endpoints (A→B and B→A) share a partner coordinate; tie-break by edge id so both ends agree on order
    list.sort((p, q) => p.key - q.key || (p.edgeId < q.edgeId ? -1 : p.edgeId > q.edgeId ? 1 : 0));
    const n = list.length;
    const spacing = n > 1 ? Math.min(MAX_SPACING, (len - SIDE_MARGIN * 2) / (n - 1)) : 0;
    list.forEach((p, i) => {
      const off = (i - (n - 1) / 2) * spacing;
      const pt = side === Position.Top ? { x: bx.cx + off, y: bx.y }
        : side === Position.Bottom ? { x: bx.cx + off, y: bx.y + bx.h }
        : side === Position.Left ? { x: bx.x, y: bx.cy + off }
        : { x: bx.x + bx.w, y: bx.cy + off };
      points.set(`${p.edgeId}:${p.end}`, pt);
    });
  }

  const out = new Map<string, Anchor>();
  for (const [id, sd] of sides) {
    const sp = points.get(`${id}:s`), tp = points.get(`${id}:t`);
    if (sp && tp) out.set(id, { sx: sp.x, sy: sp.y, tx: tp.x, ty: tp.y, sPos: sd.s, tPos: sd.t });
  }
  return out;
}

/** Must be rendered inside a ReactFlowProvider, around <ReactFlow>. */
export function EdgeAnchorsProvider({ children }: { children: React.ReactNode }) {
  const nodes = useNodes<AgentNode>();
  const edges = useEdges<ChannelEdge>();
  const anchors = React.useMemo(() => computeAnchors(nodes, edges), [nodes, edges]);
  return <AnchorsContext.Provider value={anchors}>{children}</AnchorsContext.Provider>;
}
