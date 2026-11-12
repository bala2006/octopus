import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Effort } from "@octopus/shared";
import type { RunDetail } from "@/types";

/** What the composer lets you choose for a new conversation: an Azure deployment for the whole team, and thinking. */
export type ModelSettings = { model: string | null; reasoning_effort: Effort };
export type ComposerSettings = ModelSettings;
export const defaultComposerSettings: ComposerSettings = { model: null, reasoning_effort: "default" };

export function recordedComposerSettings(budget: RunDetail["budget"] | undefined): ComposerSettings {
  return { model: budget?.model ?? null, reasoning_effort: budget?.reasoning_effort ?? "default" };
}

interface WorkbenchState {
  threads: Record<string, string | null>;
  drafts: Record<string, string>;
  pendingPrompts: Record<string, string>;
  homeDraft: string;
  preferences: Record<string, ComposerSettings>;
  configure: (workspace: string, settings: ComposerSettings) => void;
  setHomeDraft: (text: string) => void;
  stageHomePrompt: (workspace: string) => void;
  selectThread: (key: string, id: string | null) => void;
  draft: (key: string, text: string) => void;
  stagePrompt: (workspace: string, text: string) => void;
  importPrompt: (workspace: string, company: string, replace?: boolean) => void;
  discardPrompt: (workspace: string) => void;
}

/** Threads and composer drafts are scoped to both the project and selected company. */
export const useWorkbenchStore = create<WorkbenchState>()(
  persist(
    (set) => ({
      threads: {},
      drafts: {},
      pendingPrompts: {},
      homeDraft: "",
      preferences: {},
      configure: (workspace, settings) =>
        set((state) => ({
          preferences: { ...state.preferences, [workspace]: settings },
        })),
      setHomeDraft: (homeDraft) => set({ homeDraft }),
      stageHomePrompt: (workspace) =>
        set((state) =>
          state.homeDraft.trim()
            ? {
                homeDraft: "",
                pendingPrompts: {
                  ...state.pendingPrompts,
                  [workspace]: state.homeDraft,
                },
              }
            : state,
        ),
      selectThread: (key, id) =>
        set((s) => ({ threads: { ...s.threads, [key]: id } })),
      draft: (key, text) =>
        set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
      stagePrompt: (workspace, text) =>
        set((s) => ({
          pendingPrompts: { ...s.pendingPrompts, [workspace]: text },
        })),
      importPrompt: (workspace, company, replace = false) =>
        set((s) => {
          const text = s.pendingPrompts[workspace];
          const key = threadKey(workspace, company);
          if (!text || !company || (s.drafts[key]?.trim() && !replace))
            return s;
          const pendingPrompts = { ...s.pendingPrompts };
          delete pendingPrompts[workspace];
          return {
            pendingPrompts,
            drafts: { ...s.drafts, [key]: text },
            threads: { ...s.threads, [key]: null },
          };
        }),
      discardPrompt: (workspace) =>
        set((s) => {
          const pendingPrompts = { ...s.pendingPrompts };
          delete pendingPrompts[workspace];
          return { pendingPrompts };
        }),
    }),
    { name: "octopus-workbench" },
  ),
);

export const threadKey = (workspace: string, company: string) =>
  `${workspace}/${company}`;
