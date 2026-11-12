import { create } from "zustand";
import type { LiveOverlay } from "@/features/canvas/live";
import type { AgentOut } from "@/types";

/**
 * The conversation in focus, shared with the canvas behind it: agents hired during the run (shown at once, before the
 * saved team reloads) and the live overlay (who is thinking, which channels are active).
 */
interface LiveRunState {
  runId: string | null;
  hires: AgentOut[];
  overlay: LiveOverlay | null;
  publish: (runId: string | null, hires: AgentOut[], overlay: LiveOverlay | null) => void;
}

export const useLiveRun = create<LiveRunState>()((set) => ({
  runId: null,
  hires: [],
  overlay: null,
  publish: (runId, hires, overlay) => set({ runId, hires, overlay }),
}));
