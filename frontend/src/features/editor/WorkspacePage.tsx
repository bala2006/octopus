import { monaco } from "@/lib/monaco";
import * as React from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Code2,
  Bot,
  Download,
  FileCode2,
  FilePlus2,
  FolderPlus,
  FolderTree,
  GitBranch,
  Globe,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, ApiError, unwrap } from "@/lib/api";
import { cn, languageFor } from "@/lib/utils";
import { useWorkspaceId, useWorkspace } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import { Explorer } from "./Explorer";
import { PreviewPanel } from "./PreviewPanel";
import { CommandPanel } from "./CommandPanel";
import { GitPanel } from "./GitPanel";
import { TrashPanel } from "./TrashPanel";
import { FileActionDialogs, useFileActions } from "./FileActions";
import { PanelResize, usePanelSize } from "./PanelResize";
import { emptyProject, useEditorStore, type Document } from "./editorStore";
import { AgentPanel } from "./AgentPanel";
import type { CodeContext } from "./agentContext";
import { threadKey, useWorkbenchStore } from "./workbenchStore";
import { useCompanyId } from "@/hooks/queries";

type FileAction = { kind: "create" } | { kind: "folder" };
type PanelStyle = React.CSSProperties & {
  "--explorer-width": string;
  "--preview-width": string;
};

export default function WorkspacePage() {
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
  const tree = useQuery({
    queryKey: ["editor-tree", w],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/tree", {
          params: { path: pathParams },
        }),
      ),
    refetchInterval: 5000,
  });
  const [sidebar, setSidebar] = React.useState(true);
  const [panel, setPanel] = React.useState<
    "files" | "search" | "git" | "trash"
  >("files");
  const [preview, setPreview] = React.useState(false);
  const [previewAddress, setPreviewAddress] = React.useState<{ url: string }>();
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
  const [action, setAction] = React.useState<FileAction | null>(null);
  const [name, setName] = React.useState("");
  const [actionError, setActionError] = React.useState("");
  const [closing, setClosing] = React.useState<string | null>(null);
  const [conflict, setConflict] = React.useState<Document | null>(null);
  const request = React.useRef(0);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const uploadInput = React.useRef<HTMLInputElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const explorerWidth = usePanelSize("explorer", 240, 180, 420);
  const previewWidth = usePanelSize("preview", 45, 25, 65);
  const commandHeight = usePanelSize("commands", 256, 160, 600);
  const agentWidth = usePanelSize("agent", 380, 300, 620);
  const panelStyle: PanelStyle = {
    "--explorer-width": `${explorerWidth.size}px`,
    "--preview-width": `${previewWidth.size}%`,
  };
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
    if (tool === "git") {
      setSidebar(true);
      setPanel("git");
    }
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
        const doc = await unwrap(
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
  const saveAll = React.useCallback(async () => {
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
    else
      toast.success(
        `Saved ${documents.length} file${documents.length === 1 ? "" : "s"}`,
      );
  }, [busy, w, refresh]);
  // Agent edits refresh clean tabs; a draft or an in-flight save always wins over this read.
  React.useEffect(() => {
    if (!current || dirty) return;
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
        setSidebar(true);
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
          <div className="view-toolbar">
            <Button
              variant="ghost"
              size="icon"
              aria-label={sidebar ? "Hide explorer" : "Show explorer"}
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold">Workspace</h1>
              <p className="hidden text-[11px] text-muted-foreground sm:block">
                {workspace?.name} <span className="mx-1 text-border">/</span>{" "}
                Build, edit, and preview
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="sm"
                variant={agentsOpen ? "secondary" : "ghost"}
                aria-label="Toggle agent panel"
                aria-pressed={agentsOpen}
                onClick={() =>
                  agentsOpen ? setAgentsOpen(false) : focusAgent()
                }
                title="Ask Octopus (Ctrl+L)"
              >
                <Bot />
                <span className="hidden sm:inline">Agent</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Save all files"
                onClick={() => void saveAll()}
                disabled={
                  busy || !project.tabs.some((t) => t.draft !== t.content)
                }
                title="Save all (Ctrl+Shift+S)"
              >
                Save all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => startAction({ kind: "create" })}
              >
                <FilePlus2 />
                <span className="hidden sm:inline">New file</span>
              </Button>
              <Button
                size="sm"
                variant={preview ? "secondary" : "ghost"}
                aria-pressed={preview}
                onClick={() => setPreview(!preview)}
              >
                <Globe />
                Preview
              </Button>
              <Button
                size="sm"
                variant={commands ? "secondary" : "ghost"}
                aria-label="Commands"
                aria-pressed={commands}
                onClick={() => {
                  setCommandsMounted(true);
                  setCommands(!commands);
                }}
              >
                <Terminal />
                <span className="hidden sm:inline">Commands</span>
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={!dirty || busy}
                loading={busy}
              >
                <Save />
                Save
              </Button>
            </div>
          </div>
          <div ref={body} style={panelStyle} className="flex min-h-0 flex-1">
            {sidebar && (
              <aside
                className="flex w-44 shrink-0 flex-col border-r bg-surface/50 md:w-[var(--explorer-width)]"
                aria-label="Explorer"
              >
                <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
                  <Button
                    variant={panel === "files" ? "secondary" : "ghost"}
                    size="sm"
                    aria-label="Files"
                    onClick={() => setPanel("files")}
                  >
                    <FolderTree />
                    Files
                  </Button>
                  <Button
                    variant={panel === "search" ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="Search project"
                    title="Search project (Ctrl+Shift+F)"
                    onClick={() => setPanel("search")}
                  >
                    <Search />
                  </Button>
                  <Button
                    variant={panel === "git" ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="Git changes"
                    title="Review Git changes"
                    onClick={() => setPanel("git")}
                  >
                    <GitBranch />
                  </Button>
                  <Button
                    variant={panel === "trash" ? "secondary" : "ghost"}
                    size="icon"
                    aria-label="Project trash"
                    title="Restore deleted files and folders"
                    onClick={() => setPanel("trash")}
                  >
                    <Trash2 />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New folder"
                    onClick={() => startAction({ kind: "folder" })}
                  >
                    <FolderPlus />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Upload file"
                    title="Upload a file or asset"
                    onClick={() => uploadInput.current?.click()}
                  >
                    <Upload />
                  </Button>
                  <input
                    ref={uploadInput}
                    type="file"
                    className="hidden"
                    aria-label="Choose upload file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) fileActions.upload(file);
                      e.target.value = "";
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Refresh files"
                    onClick={refresh}
                  >
                    <RefreshCw
                      className={tree.isFetching ? "animate-spin" : ""}
                    />
                  </Button>
                </div>
                {tree.isError && (
                  <p role="alert" className="p-3 text-xs text-destructive">
                    {tree.error.message}
                  </p>
                )}
                {tree.isLoading && (
                  <p
                    role="status"
                    className="p-3 text-xs text-muted-foreground"
                  >
                    Loading project files…
                  </p>
                )}
                {panel === "files" ? (
                  <Explorer
                    files={tree.data?.files ?? []}
                    folders={tree.data?.folders ?? []}
                    selected={project.active}
                    onOpen={pick}
                    onAction={fileActions.start}
                    onDownload={fileActions.download}
                  />
                ) : panel === "git" ? (
                  <GitPanel workspace={w} onOpen={pick} />
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
                <div className="border-t px-3 py-2 text-[10px] text-muted-foreground">
                  {tree.data?.files.length ?? 0}
                  {tree.data?.truncated ? "+" : ""} files · dependencies and
                  secrets hidden
                </div>
              </aside>
            )}
            {sidebar && (
              <PanelResize
                label="Resize explorer"
                orientation="vertical"
                panel={explorerWidth}
              />
            )}
            <section
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                preview && "hidden md:flex",
              )}
              aria-label="Code editor"
            >
              <div
                className="flex h-11 shrink-0 overflow-x-auto border-b bg-surface/30"
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
              {opening ? (
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
                    <Button variant="outline" onClick={() => setPreview(true)}>
                      <Globe />
                      Open preview
                    </Button>
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
              ) : current ? (
                <>
                  <div className="flex min-h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
                    <span
                      title={current.path}
                      className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                    >
                      {current.path}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[11px]",
                        dirty ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {dirty ? "Unsaved" : "Saved"}
                    </span>
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
                                  query: { path: current.path },
                                },
                              },
                            ),
                          );
                          store.saved(w, doc, current.draft);
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
                        void fileActions.start("move", current.path)
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
                        void fileActions.start("trash", current.path)
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
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
                              .projects[
                                w
                              ]?.tabs.find((t) => t.path === current.path);
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
                  <div className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-[10px] text-muted-foreground">
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
                      onClick={() => {
                        setPanel("search");
                        setSidebar(true);
                      }}
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
            {preview && (
              <>
                <PanelResize
                  label="Resize preview"
                  orientation="vertical"
                  panel={previewWidth}
                  unit="percent"
                  pixelsToUnits={(delta) =>
                    (-delta * 100) / Math.max(1, body.current?.clientWidth ?? 1)
                  }
                />
                <div className="flex min-w-0 flex-1 border-l md:w-[var(--preview-width)] md:flex-none">
                  <PreviewPanel
                    workspace={w}
                    path={project.active}
                    content={current?.draft ?? ""}
                    requestedAddress={previewAddress}
                    onClose={() => setPreview(false)}
                  />
                </div>
              </>
            )}
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
                  setPreviewAddress({ url });
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
        {agentsOpen && (
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
                files={tree.data?.files ?? []}
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
