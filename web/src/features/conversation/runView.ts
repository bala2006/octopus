import { create } from "zustand";
import type { RunLive } from "@/features/runs/runState";
import type { AgentOut } from "@/types";

/**
 * The run the conversation page shows, published by the chat panel that streams it. The Browser and Review tabs and the
 * details panel sit outside that panel, so they read the run from here.
 */
export interface RunView {
  runId: string | null;
  live: boolean;
  state: RunLive | null;
  agents: Record<string, AgentOut>;
}

interface RunViewStore extends RunView {
  publish: (view: RunView) => void;
}

export const useRunView = create<RunViewStore>()((set) => ({
  runId: null,
  live: false,
  state: null,
  agents: {},
  publish: (view) => set(view),
}));
