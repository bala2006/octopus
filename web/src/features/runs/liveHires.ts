import { create } from "zustand";
import type { AgentOut } from "@/types";

/**
 * Agents hired during the active run. The chat's Team tab writes them here, and the canvas store shows them as
 * read-only nodes. Those nodes are flagged `live_hire` and are never serialized, so autosave cannot save them.
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
