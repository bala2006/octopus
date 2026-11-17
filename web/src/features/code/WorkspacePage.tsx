import { monaco } from "@/lib/monaco";
import * as React from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Code2,
  Bot,
  ChevronRight,
  ChevronsDownUp,
  Download,
  FileCode2,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Globe,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError, unwrap } from "@/lib/api";
import { cn, languageFor } from "@/lib/utils";
import { useWorkspaceId, useWorkspace } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { SidePanel, ToolbarToggle } from "@/components/ui/surfaces";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import { Explorer, type ExplorerHandle } from "./Explorer";
import { PreviewBody, PreviewControls, emptyPreview, previewUrl, type PreviewState } from "./PreviewPanel";
import { CommandPanel } from "./CommandPanel";
import { useGitStatus } from "./GitPanel";
import { changesByPath, NO_CHANGES } from "./gitMarks";
import { TrashPanel } from "./TrashPanel";
import { FileActionDialogs, useFileActions } from "./FileActions";
import { PanelResize, usePanelSize } from "./PanelResize";
import { emptyProject, useEditorStore, type Document } from "./editorStore";
import { isImagePath } from "./fileKinds";
import { AgentPanel } from "@/features/conversation/AgentPanel";
import type { CodeContext } from "@/features/conversation/agentContext";
import { threadKey, useWorkbenchStore } from "@/features/conversation/workbenchStore";
import { useCompanyId } from "@/hooks/queries";

type FileAction = { kind: "create" } | { kind: "folder" };
type PanelStyle = React.CSSProperties & {
  "--panel-size": string;
};

export default function WorkspacePage({ embedded = false }: { embedded?: boolean } = {}) {
  const w = useWorkspaceId();
  const { data: workspace } = useWorkspace(w);
  const theme = useApp((s) => s.theme);
  const store = useEditorStore();
  const project = store.projects[w] ?? emptyProject;
  const current = project.tabs.find((t) => t.path === project.active);
  const dirty = !!current && current.draft !== current.content;
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const pathParams = { workspace_id: w };
  const gitStatus = useGitStatus(w);
  const changes = React.useMemo(
    () => (gitStatus.data ? changesByPath(gitStatus.data.files) : NO_CHANGES),
    [gitStatus.data],
  );
  const [panel, setPanel] = React.useState<
    "files" | "search" | "trash"
  >("files");
  // Preview is a view of one tab. The empty key is the editor with no file open.
  const [previewTabs, setPreviewTabs] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const previewKey = project.active ?? "";
  const preview = previewTabs.has(previewKey);
  const setPreview = (on: boolean) =>
    setPreviewTabs((prev) => {
      const next = new Set(prev);
      if (on) next.add(previewKey);
      else next.delete(previewKey);
      return next;
    });
  const [previewView, setPreviewView] = React.useState<PreviewState>(() =>
    emptyPreview(""),
  );
  const view =
    previewView.key === previewKey ? previewView : emptyPreview(previewKey);
  const previewLink = previewUrl(w, project.active, view.external);
  const patchPreview = (patch: Partial<PreviewState>) =>
    setPreviewView((prev) => ({
      ...(prev.key === previewKey ? prev : emptyPreview(previewKey)),
      ...patch,
    }));
  const [commands, setCommands] = React.useState(false);
  const [commandsMounted, setCommandsMounted] = React.useState(false);
  const [agentsOpen, setAgentsOpen] = React.useState(
    () => window.innerWidth >= 1500,
  );
  React.useEffect(() => {
    const responsive = () => {
      if (window.innerWidth < 1500) setAgentsOpen(false);
    };
    window.addEventListener("resize", responsive);
    return () => window.removeEventListener("resize", responsive);
  }, []);
  const [agentFocus, setAgentFocus] = React.useState(0);
  const [selectionRequest, setSelectionRequest] = React.useState(0);
  const [selection, setSelection] = React.useState<CodeContext>();
  const [cursor, setCursor] = React.useState({ line: 1, column: 1 });
  const { companyId } = useCompanyId();
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [opening, setOpening] = React.useState(false);
  const [openError, setOpenError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const openFile = opening || openError ? undefined : current;
  const [action, setAction] = React.useState<FileAction | null>(null);
  const [name, setName] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [closing, setClosing] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<Document | null>(null);
  const request = React.useRef(0);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const explorer = React.useRef<ExplorerHandle>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const explorerWidth = usePanelSize("explorer", 264, 200, 420);
  const commandHeight = usePanelSize("commands", 256, 160, 600);
  const agentWidth = usePanelSize("agent", 380, 300, 620);
  const panelStyle: PanelStyle = {
    "--panel-size": `${explorerWidth.size}px`,
  };
  const treeFetching = useIsFetching({ queryKey: ["editor-tree", w] }) > 0;
  // The flat file list feeds only the agent aside. The Files tab loads folders as they open.
  const agentFiles = useQuery({
    queryKey: ["editor-files", w, ""],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/files", {
          params: { path: pathParams, query: { q: "" } },
        }),
      ),
    enabled: !embedded && agentsOpen,
  });
  const selectedPath = params.get("file");
  const tool = params.get("tool");
  const focusAgent = React.useCallback(() => {
    setAgentsOpen(true);
    setAgentFocus((n) => n + 1);
  }, []);
  React.useEffect(() => {
    setSelection(undefined);
  }, [current?.path]);
  React.useEffect(() => {
    if (tool === "server" || tool === "commands") {
      setCommands(true);
      setCommandsMounted(true);
    }
  }, [tool]);
  const line = Number(params.get("line")) || 1;
  const results = useQuery({
    queryKey: ["editor-search", w, query],
    enabled: !!query,
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/search", {
          params: { path: pathParams, query: { q: query } },
          signal,
        }),
      ),
  });
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const open = React.useCallback(
    async (path: string) => {
      const id = ++request.current;
      setOpenError("");
      setConflict(null);
      const existing = useEditorStore
        .getState()
        .projects[w]?.tabs.find((t) => t.path === path);
      if (existing) {
        useEditorStore.getState().select(w, path);
        setOpening(false);
        return;
      }
      setOpening(true);
      try {
        // Images are drawn from the preview route, so their bytes never load as text.
        const doc = isImagePath(path)
          ? { path, content: "", revision: "", size: 0 }
          : await unwrap(
              api.GET("/api/v1/w/{workspace_id}/editor/document", {
                params: { path: { workspace_id: w }, query: { path } },
              }),
            );
        if (request.current === id) useEditorStore.getState().open(w, doc);
      } catch (e) {
        if (request.current === id) {
          setOpenError(e instanceof Error ? e.message : "Could not open file");
          useEditorStore.getState().select(w, path);
        }
      } finally {
        if (request.current === id) setOpening(false);
      }
    },
    [w],
  );
  React.useEffect(() => {
    if (selectedPath && store.restored) void open(selectedPath);
    return () => {
      request.current++;
    };
  }, [selectedPath, open, store.restored]);
  const pick = React.useCallback(
    (path: string, at = 1) => {
      setParams({ file: path, line: String(at) });
      if (path === selectedPath) void open(path);
    },
    [setParams, selectedPath, open],
  );
  const refresh = React.useCallback(() => {
    for (const key of [
      "editor-tree",
      "editor-files",
      "files",
      "editor-search",
      "git-status",
      "editor-trash",
    ])
      void qc.invalidateQueries({ queryKey: [key, w] });
  }, [qc, w]);
  const fileActions = useFileActions(w, pick, refresh);

  const save = React.useCallback(async () => {
    if (!current || !dirty || busy) return;
    setBusy(true);
    try {
      const doc = await unwrap(
        api.PUT("/api/v1/w/{workspace_id}/editor/document", {
          params: { path: { workspace_id: w } },
          body: {
            path: current.path,
            content: current.draft,
            revision: current.revision,
          },
        }),
      );
      useEditorStore.getState().saved(w, doc, current.draft);
      setConflict(null);
      toast.success(`Saved ${doc.path}`);
      void qc.invalidateQueries({ queryKey: ["editor-search", w] });
      void qc.invalidateQueries({ queryKey: ["git-status", w] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
      if (e instanceof ApiError && e.status === 409) {
        try {
          setConflict(
            await unwrap(
              api.GET("/api/v1/w/{workspace_id}/editor/document", {
                params: {
                  path: { workspace_id: w },
                  query: { path: current.path },
                },
              }),
            ),
          );
        } catch {
          /* Keep the unsaved draft when the disk file has been deleted. */
        }
      }
    } finally {
      setBusy(false);
    }
  }, [current, dirty, busy, w, qc]);
  const saveAll = React.useCallback(async (options?: { quiet?: boolean }) => {
    if (busy) return;
    const documents =
      useEditorStore
        .getState()
        .projects[w]?.tabs.filter((t) => t.draft !== t.content) ?? [];
    if (!documents.length) return;
    setBusy(true);
    const failed: string[] = [];
    for (const tab of documents) {
      try {
        const doc = await unwrap(
          api.PUT("/api/v1/w/{workspace_id}/editor/document", {
            params: { path: { workspace_id: w } },
            body: {
              path: tab.path,
              content: tab.draft,
              revision: tab.revision,
            },
          }),
        );
        useEditorStore.getState().saved(w, doc, tab.draft);
      } catch {
        failed.push(tab.path);
      }
    }
    setBusy(false);
    refresh();
    if (failed.length)
      toast.error(`Could not save ${failed.join(", ")}`, {
        description:
          "Drafts are preserved. Open each file and save to review any disk conflict.",
      });
    else if (!options?.quiet)
      toast.success(
        `Saved ${documents.length} file${documents.length === 1 ? "" : "s"}`,
      );
  }, [busy, w, refresh]);
  // Autosave: a tab's edits reach disk once typing pauses. A failed write stays unsaved, so the header keeps showing Unsaved.
  const saveAllRef = React.useRef(saveAll);
  saveAllRef.current = saveAll;
  React.useEffect(() => {
    if (!project.tabs.some((tab) => tab.draft !== tab.content)) return;
    const timer = setTimeout(() => void saveAllRef.current({ quiet: true }), 800);
    return () => clearTimeout(timer);
  }, [project.tabs]);
  // Agent edits refresh clean tabs; a draft or an in-flight save always wins over this read.
  React.useEffect(() => {
    if (!current || dirty || isImagePath(current.path)) return;
    const path = current.path;
    let cancelled = false;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading || document.hidden) return;
      const before = useEditorStore
        .getState()
        .projects[w]?.tabs.find((t) => t.path === path);
      if (!before || before.draft !== before.content) return;
      reading = true;
      try {
        const doc = await unwrap(
          api.GET("/api/v1/w/{workspace_id}/editor/document", {
            params: { path: { workspace_id: w }, query: { path } },
          }),
        );
        const now = useEditorStore
          .getState()
          .projects[w]?.tabs.find((t) => t.path === path);
        if (
          !cancelled &&
          now &&
          now.revision === before.revision &&
          now.draft === now.content &&
          doc.revision !== now.revision
        )
          useEditorStore.getState().saved(w, doc, now.draft);
      } catch {
        /* Preserve the tab when a file is removed or the backend is disconnected. */
      } finally {
        reading = false;
      }
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [w, current?.path, current?.revision, dirty]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) void saveAll();
        else void save();
      }
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setPanel("search");
        setTimeout(() => searchInput.current?.focus(), 0);
      }
      if (e.key.toLowerCase() === "l") {
        e.preventDefault();
        focusAgent();
      }
      if (e.key === "`") {
        e.preventDefault();
        setCommandsMounted(true);
        setCommands((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saveAll, focusAgent]);

  const startAction = (next: FileAction) => {
    setActionError("");
    setName("");
    setAction(next);
  };
  const submitAction = async () => {
    if (!action || !name.trim() || busy) return;
    setBusy(true);
    setActionError("");
    try {
      if (action.kind === "folder")
        await unwrap(
          api.POST("/api/v1/w/{workspace_id}/editor/folder", {
            params: { path: pathParams },
            body: { path: name.trim() },
          }),
        );
      else {
        const doc = await unwrap(
          api.PUT("/api/v1/w/{workspace_id}/editor/document", {
            params: { path: pathParams },
            body: { path: name.trim(), content: "", revision: null },
          }),
        );
        store.open(w, doc);
        setParams({ file: doc.path });
      }
      refresh();
      setAction(null);
      toast.success(
        action.kind === "folder" ? "Folder created" : "File created",
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };
  const closeTab = (path: string) => {
    store.close(w, path);
    setPreviewTabs((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    monaco.editor.getModel(monaco.Uri.parse(`${w}/${path}`))?.dispose();
    setParams({});
    setOpenError("");
    setConflict(null);
  };

  return (
    <div
      className="flex h-full min-w-0 flex-col"
      data-testid="workspace-editor"
    >
      {store.recoveryError && (
        <p
          role="alert"
          className="border-b bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {store.recoveryError}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={body} style={panelStyle} className="flex min-h-0 flex-1">
            <SidePanel
              label="Explorer"
              className="is-sized"
              header={
                <>
                  <FolderOpen
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    title={workspace?.name}
                  >
                    {workspace?.name ?? "Project"}
                  </span>
                  <div className="flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6"
                      aria-label="New file"
                      title="New file"
                      onClick={() => startAction({ kind: "create" })}
                    >
                      <FilePlus2 />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6"
                      aria-label="New folder"
                      title="New folder"
                      onClick={() => startAction({ kind: "folder" })}
                    >
                      <FolderPlus />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6"
                      aria-label="Refresh files"
                      title="Refresh files"
                      onClick={refresh}
                    >
                      <RefreshCw
                        className={treeFetching ? "animate-spin" : ""}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6"
                      aria-label="Collapse all folders"
                      title="Collapse all folders"
                      onClick={() => explorer.current?.collapseAll()}
                    >
                      <ChevronsDownUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6 aria-pressed:bg-accent"
                      aria-label="Project trash"
                      aria-pressed={panel === "trash"}
                      title="Restore deleted files and folders"
                      onClick={() =>
                        setPanel(panel === "trash" ? "files" : "trash")
                      }
                    >
                      <Trash2 />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-6 w-6 aria-pressed:bg-accent"
                      aria-label="Search project"
                      aria-pressed={panel === "search"}
                      title="Search project (Ctrl+Shift+F)"
                      onClick={() =>
                        setPanel(panel === "search" ? "files" : "search")
                      }
                    >
                      <Search />
                    </Button>
                  </div>
                </>
              }
            >
                {panel === "files" ? (
                  <Explorer
                    ref={explorer}
                    workspace={w}
                    changes={changes}
                    selected={project.active}
                    onOpen={pick}
                    onAction={fileActions.start}
                    onDownload={fileActions.download}
                  />
                ) : panel === "trash" ? (
                  <TrashPanel workspace={w} onOpen={pick} onRefresh={refresh} />
                ) : (
                  <>
                    <Input
                      ref={searchInput}
                      className="m-2 h-9 w-auto text-xs"
                      aria-label="Search file contents"
                      placeholder="Search file contents…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      maxLength={200}
                    />
                    <div
                      className="min-h-0 flex-1 overflow-auto p-2"
                      aria-live="polite"
                    >
                      {results.isFetching ? (
                        <p className="p-2 text-xs text-muted-foreground">
                          Searching…
                        </p>
                      ) : results.isError ? (
                        <p
                          role="alert"
                          className="p-2 text-xs text-destructive"
                        >
                          {results.error.message}
                        </p>
                      ) : query && results.data ? (
                        <>
                          <p className="px-2 pb-2 text-[11px] text-muted-foreground">
                            {results.data.matches.length}
                            {results.data.truncated ? "+" : ""} matches ·{" "}
                            {results.data.searched} files searched
                          </p>
                          {results.data.matches.map((m) => (
                            <button
                              key={`${m.path}:${m.line}`}
                              onClick={() => pick(m.path, m.line)}
                              className="mb-1 w-full rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
                            >
                              <span className="block truncate text-xs font-medium">
                                {m.path}:{m.line}
                              </span>
                              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                                {m.text}
                              </span>
                            </button>
                          ))}
                          {!results.data.matches.length && (
                            <p className="p-2 text-xs text-muted-foreground">
                              No matches. Try a different phrase.
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="p-2 text-xs leading-relaxed text-muted-foreground">
                          Find text across your project. Results open at the
                          matching line. Search ignores case.
                        </p>
                      )}
                    </div>
                  </>
                )}
                <div className="side-panel-footer">
                  dependencies and
                  secrets hidden
                </div>
              </SidePanel>
            <PanelResize
                label="Resize explorer"
                orientation="vertical"
                panel={explorerWidth}
              />
            <section
              className="flex min-w-0 flex-1 flex-col"
              aria-label="Code editor"
            >
              <div
                className={cn(
                  "h-[calc(var(--toolbar-h)*2/3)] shrink-0 overflow-x-auto border-b bg-surface/30",
                  project.tabs.length ? "flex" : "hidden",
                )}
                aria-label="Open files"
              >
                {project.tabs.map((tab) => (
                  <div
                    key={tab.path}
                    className={cn(
                      "flex shrink-0 items-center gap-1 border-r px-2 text-xs",
                      project.active === tab.path
                        ? "border-t-2 border-t-primary bg-background"
                        : "text-muted-foreground",
                    )}
                  >
                    <button
                      title={tab.path}
                      className="flex h-full items-center gap-2 px-1"
                      onClick={() => pick(tab.path)}
                    >
                      <FileCode2 className="h-3.5 w-3.5" />
                      {tab.path.split("/").pop()}
                      {tab.draft !== tab.content && (
                        <span
                          aria-label="Unsaved changes"
                          className="h-1.5 w-1.5 rounded-full bg-primary"
                        />
                      )}
                    </button>
                    <button
                      className="rounded p-1 transition hover:bg-accent"
                      aria-label={`Close ${tab.path}`}
                      onClick={() =>
                        tab.draft !== tab.content
                          ? setClosing(tab.path)
                          : closeTab(tab.path)
                      }
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex min-h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
                {preview ? (
                  <PreviewControls
                    state={view}
                    url={previewLink}
                    onChange={patchPreview}
                  />
                ) : openFile ? (
                  <nav
                    aria-label="Breadcrumb"
                    title={openFile.path}
                    className="flex min-w-0 flex-1 items-center gap-1 font-mono text-muted-foreground"
                  >
                    {openFile.path.split("/").map((part, i, parts) => (
                      <React.Fragment key={`${i}-${part}`}>
                        {i > 0 && (
                          <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
                        )}
                        <span
                          className={cn(
                            "truncate",
                            i === parts.length - 1 && "text-foreground",
                          )}
                        >
                          {part}
                        </span>
                      </React.Fragment>
                    ))}
                  </nav>
                ) : (
                  <span className="flex-1" />
                )}
                {openFile && !preview && (
                  <>
                    <span
                      className={cn(
                        "shrink-0 text-[11px]",
                        dirty ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {dirty ? "Unsaved" : "Saved"}
                    </span>
                    {!isImagePath(openFile.path) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Reload file from disk"
                      disabled={dirty || busy}
                      title={
                        dirty
                          ? "Save or discard your edits before reloading"
                          : "Reload file from disk"
                      }
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const doc = await unwrap(
                            api.GET(
                              "/api/v1/w/{workspace_id}/editor/document",
                              {
                                params: {
                                  path: pathParams,
                                  query: { path: openFile.path },
                                },
                              },
                            ),
                          );
                          store.saved(w, doc, openFile.draft);
                          toast.success("Reloaded from disk");
                        } catch (e) {
                          toast.error(
                            e instanceof Error ? e.message : "Reload failed",
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      <RefreshCw />
                    </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Rename or move file"
                      disabled={dirty || busy}
                      title={
                        dirty
                          ? "Save your changes before renaming"
                          : "Rename or move file"
                      }
                      onClick={() =>
                        void fileActions.start("move", openFile.path)
                      }
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete file"
                      disabled={dirty || busy}
                      title={
                        dirty
                          ? "Save your changes before deleting"
                          : "Delete file"
                      }
                      onClick={() =>
                        void fileActions.start("trash", openFile.path)
                      }
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
                {(openFile || preview) && (
                  <span className="toolbar-divider" aria-hidden />
                )}
                <ToolbarToggle
                  pressed={preview}
                  onClick={() => setPreview(!preview)}
                >
                  <Globe />
                  Preview
                </ToolbarToggle>
                <ToolbarToggle
                  pressed={commands}
                  aria-label="Commands"
                  onClick={() => {
                    setCommandsMounted(true);
                    setCommands(!commands);
                  }}
                >
                  <Terminal />
                  <span className="hidden sm:inline">Commands</span>
                </ToolbarToggle>
                {!embedded && (
                  <ToolbarToggle
                    pressed={agentsOpen}
                    aria-label="Toggle agent panel"
                    title="Ask Octopus (Ctrl+L)"
                    onClick={() =>
                      agentsOpen ? setAgentsOpen(false) : focusAgent()
                    }
                  >
                    <Bot />
                    <span className="hidden sm:inline">Agent</span>
                  </ToolbarToggle>
                )}
              </div>
              {preview ? (
                <PreviewBody
                  state={view}
                  url={previewLink}
                  path={project.active}
                  content={current?.draft ?? ""}
                  onChange={patchPreview}
                />
              ) : opening ? (
                <div
                  role="status"
                  className="m-auto flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Opening file…
                </div>
              ) : openError ? (
                <div
                  role="alert"
                  className="m-auto max-w-md p-6 text-center text-sm"
                >
                  <p>{openError}</p>
                  <div className="mt-3 flex flex-wrap justify-center gap-2">
                    {project.active && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (project.active)
                            void fileActions.download(project.active);
                        }}
                      >
                        <Download />
                        Download file
                      </Button>
                    )}
                  </div>
                </div>
              ) : current && isImagePath(current.path) ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
                  <img
                    src={`/api/v1/w/${w}/preview/${current.path.split("/").map(encodeURIComponent).join("/")}`}
                    alt={current.path}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : current ? (
                <>
                  {conflict && conflict.path === current.path && (
                    <div
                      role="alert"
                      className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs"
                    >
                      <p className="flex-1">
                        The file changed on disk. Disk version is on the left;
                        your draft is on the right.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          store.saved(w, conflict, conflict.content);
                          setConflict(null);
                        }}
                      >
                        Keep my edits
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          store.edit(w, current.path, conflict.content);
                          store.saved(w, conflict, conflict.content);
                          setConflict(null);
                        }}
                      >
                        Use disk version
                      </Button>
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    {conflict && conflict.path === current.path ? (
                      <DiffEditor
                        height="100%"
                        language={languageFor(current.path)}
                        original={conflict.content}
                        modified={current.draft}
                        theme={
                          theme === "dark" ? "octopus-dark" : "octopus-light"
                        }
                        options={{
                          readOnly: true,
                          minimap: { enabled: false },
                          renderSideBySide: true,
                        }}
                      />
                    ) : (
                      <Editor
                        key={`${w}/${current.path}:${line}`}
                        path={`${w}/${current.path}`}
                        height="100%"
                        keepCurrentModel
                        language={languageFor(current.path)}
                        value={current.draft}
                        onChange={(value) =>
                          store.edit(w, current.path, value ?? "")
                        }
                        theme={
                          theme === "dark" ? "octopus-dark" : "octopus-light"
                        }
                        onMount={(editor) => {
                          editor.revealLineInCenter(line);
                          editor.setPosition({ lineNumber: line, column: 1 });
                          const selectedCode = () => {
                            const range = editor.getSelection();
                            const tab = useEditorStore
                              .getState()
                              .projects[w]?.tabs.find(
                                (t) => t.path === current.path,
                              );
                            return range && !range.isEmpty()
                              ? {
                                  path: current.path,
                                  startLine: range.startLineNumber,
                                  endLine: range.endLineNumber,
                                  content:
                                    editor.getModel()?.getValueInRange(range) ??
                                    "",
                                  dirty: !!tab && tab.draft !== tab.content,
                                }
                              : undefined;
                          };
                          editor.onDidChangeCursorSelection(() => {
                            const at = editor.getPosition();
                            if (at)
                              setCursor({
                                line: at.lineNumber,
                                column: at.column,
                              });
                            setSelection(selectedCode());
                          });
                          editor.addAction({
                            id: "octopus.ask-selection",
                            label: "Ask Octopus about selected code",
                            keybindings: [
                              monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI,
                            ],
                            contextMenuGroupId: "navigation",
                            contextMenuOrder: 1.5,
                            run: () => {
                              setSelection(selectedCode());
                              setSelectionRequest((n) => n + 1);
                              focusAgent();
                            },
                          });
                        }}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          fontFamily: "JetBrains Mono Variable, monospace",
                          scrollBeyondLastLine: false,
                          padding: { top: 16 },
                          automaticLayout: true,
                        }}
                      />
                    )}
                  </div>
                  <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-surface/40 px-3 text-[11px] text-muted-foreground">
                    <Code2 className="h-3 w-3" />
                    {languageFor(current.path)}
                    <span>UTF-8</span>
                    <span>
                      Ln {cursor.line}, Col {cursor.column}
                    </span>
                    {selection?.content && (
                      <button
                        className="text-primary"
                        onClick={() => {
                          setSelectionRequest((n) => n + 1);
                          focusAgent();
                        }}
                      >
                        Ask about selection
                      </button>
                    )}
                    <span className="ml-auto">Ctrl / ⌘ S to save</span>
                  </div>
                </>
              ) : (
                <div className="m-auto max-w-md p-6 text-center">
                  <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-steel/20 bg-steel/10 text-steel">
                    <Code2 className="h-7 w-7" />
                  </div>
                  <h2 className="text-lg font-semibold">
                    Your project, ready to build
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    Open a file to start editing, search your code, or preview
                    the app alongside your work.
                  </p>
                  <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => startAction({ kind: "create" })}
                    >
                      <FilePlus2 />
                      Create a file
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPanel("search")}
                    >
                      <Search />
                      Search project
                    </Button>
                  </div>
                  <p className="mt-6 text-xs text-muted-foreground">
                    Quick open <kbd className="kbd">Ctrl K</kbd>
                  </p>
                </div>
              )}
            </section>
          </div>
          {commandsMounted && (
            <div className={commands ? "" : "hidden"}>
              <PanelResize
                label="Resize commands"
                orientation="horizontal"
                panel={commandHeight}
                pixelsToUnits={(delta) => -delta}
              />
              <CommandPanel
                key={w}
                workspace={w}
                height={commandHeight.size}
                visible={commands}
                initialMode={tool === "server" ? "server" : "commands"}
                onClose={() => setCommands(false)}
                onComplete={refresh}
                onPreview={(url) => {
                  patchPreview({ address: url, external: url });
                  setPreview(true);
                }}
                onExplain={(command, output) => {
                  useWorkbenchStore
                    .getState()
                    .draft(
                      threadKey(w, companyId),
                      `Diagnose this command output and propose a fix.\n\nCommand: ${command}\n\n${output.slice(-6000)}`,
                    );
                  focusAgent();
                }}
              />
            </div>
          )}
        </div>
        {!embedded && agentsOpen && (
          <>
            <PanelResize
              label="Resize agent panel"
              orientation="vertical"
              panel={agentWidth}
              pixelsToUnits={(delta) => -delta}
            />
            <aside
              className="absolute inset-y-0 right-0 z-20 w-full max-w-lg shrink-0 border-l bg-background shadow-xl lg:relative lg:z-auto lg:max-w-none lg:shadow-none"
              style={{ width: `min(100%, ${agentWidth.size}px)` }}
            >
              <AgentPanel
                workspace={w}
                current={
                  current
                    ? { path: current.path, content: current.draft, dirty }
                    : undefined
                }
                selection={selection}
                selectionToken={selectionRequest}
                onSelectionConsumed={() => setSelectionRequest(0)}
                files={agentFiles.data?.files ?? []}
                onOpen={pick}
                onClose={() => setAgentsOpen(false)}
                focusToken={agentFocus}
              />
            </aside>
          </>
        )}
      </div>
      <Dialog
        open={!!action}
        onOpenChange={(isOpen) => {
          if (!isOpen && !busy) setAction(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>
            {action?.kind === "folder" ? "Create folder" : "Create file"}
          </DialogTitle>
          <DialogDescription>
            Enter a path relative to your project. Parent folders are created
            automatically.
          </DialogDescription>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitAction();
            }}
            className="space-y-3"
          >
            <Input
              autoFocus
              aria-label="File or folder path"
              placeholder={
                action?.kind === "folder" ? "src/components" : "src/index.html"
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={400}
            />
            {actionError && (
              <p role="alert" className="text-xs text-destructive">
                {actionError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setAction(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || busy}
                loading={busy}
              >
                Create
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <FileActionDialogs actions={fileActions} />
      <ConfirmDialog
        open={!!closing}
        onOpenChange={(isOpen) => {
          if (!isOpen) setClosing(null);
        }}
        title="Discard unsaved changes?"
        description={`Your edits to ${closing ?? "this file"} have not been saved.`}
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          if (closing) closeTab(closing);
          setClosing(null);
        }}
      />
    </div>
  );
}
