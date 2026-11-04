import { create } from "zustand";
import type { AgentOut } from "@/types";
import { toNode, type AgentNode } from "@/stores/canvas";

/**
 * Agents hired during the active run. The chat's Team tab writes them here and the canvas shows them as read-only
 * previews. They never enter the company store, so autosave cannot save run-only agents as company agents.
 */
interface LiveHiresState {
  runId: string | null;
  agents: AgentOut[];
  setHires: (runId: string | null, agents: AgentOut[]) => void;
}

export const useLiveHires = create<LiveHiresState>()((set) => ({
  runId: null,
  agents: [],
  setHires: (runId, agents) => set({ runId, agents }),
}));

const COLUMN_GAP = 260;
const ROW_GAP = 220;

/** Add hired agents to the canvas nodes, placed below the agent that hired them. Already-saved agents are skipped. */
export function withLiveHires(
  nodes: AgentNode[],
  hires: AgentOut[],
): AgentNode[] {
  if (!hires.length) return nodes;
  const positions = new Map(nodes.map((n) => [n.id, n.position]));
  const known = new Set(nodes.map((n) => n.id));
  const childCount = new Map<string, number>();
  let lowest = nodes.reduce((max, n) => Math.max(max, n.position.y), 0);
  const extra: AgentNode[] = [];
  for (const agent of hires) {
    if (known.has(agent.id)) continue;
    const parent = agent.created_by
      ? positions.get(agent.created_by)
      : undefined;
    let position: { x: number; y: number };
    if (parent) {
      const slot = childCount.get(agent.created_by!) ?? 0;
      childCount.set(agent.created_by!, slot + 1);
      position = { x: parent.x + slot * COLUMN_GAP, y: parent.y + ROW_GAP };
    } else {
      lowest += ROW_GAP;
      position = { x: 0, y: lowest };
    }
    positions.set(agent.id, position);
    known.add(agent.id);
    extra.push({
      ...toNode(agent),
      position,
      draggable: false,
      selectable: false,
      connectable: false,
      className: "live-hire",
    });
  }
  return [...nodes, ...extra];
}
