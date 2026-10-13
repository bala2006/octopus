import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WorkbenchState {
  threads: Record<string, string | null>;
  drafts: Record<string, string>;
  selectThread: (key: string, id: string | null) => void;
  draft: (key: string, text: string) => void;
}

/** Threads and composer drafts are scoped to both the project and selected company. */
export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      threads: {},
      drafts: {},
      selectThread: (key, id) =>
        set((s) => ({ threads: { ...s.threads, [key]: id } })),
      draft: (key, text) =>
        set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
    }),
    { name: "octopus-workbench" },
  ),
);

export const threadKey = (workspace: string, company: string) =>
  `${workspace}/${company}`;
