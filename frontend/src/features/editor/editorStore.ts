import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { components } from "@/types/api.gen";
import { draftStorage } from "./draftStorage";

export type Document = components["schemas"]["Document"];
export type OpenDocument = Document & { draft: string };
export type Project = { tabs: OpenDocument[]; active: string | null };
const empty: Project = { tabs: [], active: null };

interface EditorState {
  projects: Record<string, Project>;
  restored: boolean;
  recoveryError: string;
  recovery: (error?: string) => void;
  open: (workspace: string, document: Document) => void;
  select: (workspace: string, path: string) => void;
  edit: (workspace: string, path: string, draft: string) => void;
  saved: (workspace: string, document: Document, submitted: string) => void;
  close: (workspace: string, path: string) => void;
  move: (workspace: string, path: string, destination: string) => void;
  remove: (workspace: string, path: string) => void;
}

function isProjects(value: unknown): value is Record<string, Project> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((project: unknown) => {
    if (
      !project ||
      typeof project !== "object" ||
      !("tabs" in project) ||
      !Array.isArray(project.tabs) ||
      !("active" in project) ||
      (project.active !== null && typeof project.active !== "string")
    )
      return false;
    return project.tabs.every(
      (tab: unknown) =>
        tab &&
        typeof tab === "object" &&
        "path" in tab &&
        typeof tab.path === "string" &&
        "content" in tab &&
        typeof tab.content === "string" &&
        "draft" in tab &&
        typeof tab.draft === "string" &&
        "revision" in tab &&
        typeof tab.revision === "string" &&
        /^[a-f0-9]{64}$/.test(tab.revision) &&
        "size" in tab &&
        typeof tab.size === "number" &&
        Number.isFinite(tab.size),
    );
  });
}

export const useEditorStore = create<EditorState>()(
  persist(
    (set) => ({
      projects: {},
      restored: false,
      recoveryError: "",
      recovery: (error = "") => set({ restored: true, recoveryError: error }),
      open: (w, doc) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          return {
            projects: {
              ...s.projects,
              [w]: {
                active: doc.path,
                tabs: project.tabs.some((t) => t.path === doc.path)
                  ? project.tabs
                  : [...project.tabs, { ...doc, draft: doc.content }],
              },
            },
          };
        }),
      select: (w, path) =>
        set((s) => ({
          projects: {
            ...s.projects,
            [w]: { ...(s.projects[w] ?? empty), active: path },
          },
        })),
      edit: (w, path, draft) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          return {
            projects: {
              ...s.projects,
              [w]: {
                ...project,
                tabs: project.tabs.map((t) =>
                  t.path === path ? { ...t, draft } : t,
                ),
              },
            },
          };
        }),
      saved: (w, doc, submitted) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          return {
            projects: {
              ...s.projects,
              [w]: {
                ...project,
                tabs: project.tabs.map((t) =>
                  t.path === doc.path
                    ? {
                        ...doc,
                        draft: t.draft === submitted ? doc.content : t.draft,
                      }
                    : t,
                ),
              },
            },
          };
        }),
      close: (w, path) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          const index = project.tabs.findIndex((t) => t.path === path);
          const tabs = project.tabs.filter((t) => t.path !== path);
          return {
            projects: {
              ...s.projects,
              [w]: {
                tabs,
                active:
                  project.active === path
                    ? (tabs[Math.min(index, tabs.length - 1)]?.path ?? null)
                    : project.active,
              },
            },
          };
        }),
      move: (w, path, destination) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          const remap = (p: string) =>
            p === path || p.startsWith(`${path}/`)
              ? destination + p.slice(path.length)
              : p;
          return {
            projects: {
              ...s.projects,
              [w]: {
                tabs: project.tabs.map((t) => ({ ...t, path: remap(t.path) })),
                active: project.active && remap(project.active),
              },
            },
          };
        }),
      remove: (w, path) =>
        set((s) => {
          const project = s.projects[w] ?? empty;
          const includes = (p: string) =>
            p === path || p.startsWith(`${path}/`);
          const tabs = project.tabs.filter((t) => !includes(t.path));
          return {
            projects: {
              ...s.projects,
              [w]: {
                tabs,
                active:
                  project.active && includes(project.active)
                    ? (tabs.at(-1)?.path ?? null)
                    : project.active,
              },
            },
          };
        }),
    }),
    {
      name: "workspace-drafts",
      version: 1,
      storage: createJSONStorage(() => ({
        ...draftStorage,
        setItem: async (name, value) => {
          try {
            await draftStorage.setItem(name, value);
          } catch {
            const message =
              "Draft recovery is unavailable. Save your files before closing the browser.";
            if (useEditorStore.getState().recoveryError !== message)
              useEditorStore.setState({ recoveryError: message });
          }
        },
      })),
      partialize: (state) => ({ projects: state.projects }),
      merge: (saved, current) => {
        if (
          saved &&
          typeof saved === "object" &&
          "projects" in saved &&
          isProjects(saved.projects)
        ) {
          return {
            ...current,
            projects: { ...saved.projects, ...current.projects },
          };
        }
        return current;
      },
      onRehydrateStorage: () => (state, error) => {
        if (state)
          state.recovery(
            error
              ? "Draft recovery is unavailable. Save files before closing the browser."
              : "",
          );
        else
          useEditorStore.setState({
            restored: true,
            recoveryError:
              "Draft recovery is unavailable. Save files before closing the browser.",
          });
      },
    },
  ),
);

export const emptyProject = empty;
