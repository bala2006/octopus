import * as React from "react";
import { tone } from "@/lib/palette";
import {
  Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow,
} from "@xyflow/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle, Check, ClipboardPaste, Cloud, CloudOff, Download, Flag, Grid3x3, LayoutGrid, Loader2, Maximize, MessageSquare, Network,
  Plus, Redo2, Settings2, Trash2, Undo2, Upload, CopyPlus, MousePointerSquareDashed, Building2, BookmarkPlus, MoreHorizontal,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, unwrap } from "@/lib/api";
import { download, timeAgo } from "@/lib/utils";
import { qk, useCanvas as useCanvasQuery, useCompanyId, useRoleTemplates, useSettings, useWorkspaceId } from "@/hooks/queries";
import { useCanvas, type AgentNode as AgentNodeT, type ChannelEdge as ChannelEdgeT } from "@/stores/canvas";
import type { CanvasOut } from "@/types";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
  ContextMenuTrigger, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Tip,
} from "@/components/ui/overlays";
import { GettingStarted } from "@/features/onboarding/GettingStarted";
import { NewCompanyDialog } from "@/features/projects/NewCompanyDialog";
import { useOpenConversation } from "@/features/conversation/useOpenConversation";
import { edgeTypes, nodeTypes } from "./flowTypes";
import { EdgeAnchorsProvider } from "./edgeAnchors";
import { DepartmentBuilder } from "./DepartmentBuilder";
import { DepartmentZones } from "./DepartmentZones";
import { CanvasMiniMap } from "./CanvasMiniMap";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { EdgeEditor } from "./EdgeEditor";
import { Inspector } from "./Inspector";
import { DND_MIME, Palette } from "./Palette";
import { useAutosave, type SaveState } from "./useAutosave";
import { useLiveRun } from "@/features/runs/liveRun";
import { LiveContext } from "./live";


export default function CanvasPage({ embedded = false, rightInset = 0, leftInset = 0 }: { embedded?: boolean; rightInset?: number; leftInset?: number }) {
  const w = useWorkspaceId();
  const { companyId, loading } = useCompanyId();
  const [creating, setCreating] = React.useState(false);
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!companyId) {
    return (
      <>
        <EmptyState icon={Network} title="Create your first team"
          description="A team is a group of AI agents led by Octopus, the team lead. Pick a ready-made template (you can change everything later) or describe your goal and let AI design one."
          action={<Button onClick={() => setCreating(true)} data-testid="new-company"><Plus />Create team</Button>} />
        {!embedded && <div className="pointer-events-none fixed bottom-4 left-4 z-10"><GettingStarted /></div>}
        <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      </>
    );
  }
  return <ReactFlowProvider><CanvasEditor key={`${w}:${companyId}`} workspaceId={w} companyId={companyId} embedded={embedded} rightInset={rightInset} leftInset={leftInset} /></ReactFlowProvider>;
}

function CanvasEditor({ workspaceId, companyId, embedded, rightInset, leftInset }: { workspaceId: string; companyId: string; embedded: boolean; rightInset: number; leftInset: number }) {
  const q = useCanvasQuery(workspaceId, companyId);
  const s = useCanvas();
  const liveHires = useLiveRun((l) => l.hires);
  const overlay = useLiveRun((l) => l.overlay);
  React.useEffect(() => { useCanvas.getState().setLiveHires(liveHires); }, [liveHires]);
  const rf = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const roles = useRoleTemplates();
  const settings = useSettings();
  const nav = useNavigate();
  const qc = useQueryClient();
  const autosave = useAutosave(workspaceId, companyId);
  const openConversation = useOpenConversation();
  // The canvas designs the team; the work happens in Conversation, with a fresh thread for this team.
  const talkToTeam = () => { void autosave.saveNow(); openConversation(workspaceId, null, companyId); };
  const [deptOpen, setDeptOpen] = React.useState(false);
  const [tplOpen, setTplOpen] = React.useState(false);
  const wrapper = React.useRef<HTMLDivElement>(null);
  const menuPos = React.useRef<{ x: number; y: number } | null>(null);
  const [menuNode, setMenuNode] = React.useState<AgentNodeT | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const fitOptions = React.useMemo(() => ({
    padding: embedded ? { top: "72px", right: `${rightInset + 24}px`, bottom: "56px", left: `${leftInset + 24}px` } : .2,
    maxZoom: embedded ? 1 : 2,
  } satisfies NonNullable<Parameters<typeof rf.fitView>[0]>), [embedded, rightInset, leftInset]);
  const fitCanvas = React.useCallback((duration = 0) => rf.fitView({ ...fitOptions, duration }), [rf, fitOptions]);
  const canvasStyle: React.CSSProperties & { "--conversation-canvas-right-inset": string; "--conversation-canvas-left-inset": string } = { "--conversation-canvas-right-inset": `${rightInset}px`, "--conversation-canvas-left-inset": `${leftInset}px` };

  // layout effect: swap the store before paint so a stale company is never shown (or edited) for a frame
  React.useLayoutEffect(() => {
    if (!q.data) return;
    const st = useCanvas.getState();
    const unsaved = st.version !== 0 && st.version !== st.savedVersion;
    const otherCompany = st.companyId !== companyId;
    // load when switching company, or when the server has a newer team (e.g. agents hired during a run) and we have no local edits
    if (otherCompany || (!unsaved && (q.data.revision ?? 0) > st.revision)) {
      st.load(q.data);
      if (otherCompany) requestAnimationFrame(() => fitCanvas(300));
    }
  }, [q.data, companyId, fitCanvas]);

  React.useEffect(() => {
    if (!embedded || !nodesInitialized || !wrapper.current) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        timer = setTimeout(() => void fitCanvas(), 120);
      }
    });
    observer.observe(wrapper.current);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [embedded, nodesInitialized, fitCanvas]);

  const defaults = React.useMemo(() => ({ provider: settings.data?.default_provider ?? "azure", model: settings.data?.default_model ?? "gpt-6-luna" }), [settings.data]);
  const addRole = React.useCallback((key: string, screen?: { x: number; y: number }) => {
    const t = roles.data?.find((r) => r.key === key);
    if (!t) return;
    const rect = wrapper.current?.getBoundingClientRect();
    const pt = screen ?? { x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 };
    const pos = rf.screenToFlowPosition(pt);
    useCanvas.getState().addAgent(t, { x: pos.x - 125, y: pos.y - 60 }, defaults);
    toast.success(`Added ${t.default_name} (${t.role})`, { duration: 1500 });
  }, [roles.data, rf, defaults]);

  // keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      if (embedded && !wrapper.current?.contains(t)) return;
      const mod = e.ctrlKey || e.metaKey;
      const st = useCanvas.getState();
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); st.undo(); }
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); st.redo(); }
      else if (mod && e.key.toLowerCase() === "c") { const n = st.copy(); if (n) toast(`Copied ${n} agent(s)`, { duration: 1200 }); }
      else if (mod && e.key.toLowerCase() === "v") { e.preventDefault(); st.paste(); }
      else if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); st.selectAll(); }
      else if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); st.duplicate(st.nodes.filter((n) => n.selected).map((n) => n.id)); }
      else if (e.key === "Escape") { st.setQuickConfig(null); st.setEdgeEdit(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded]);

  const exportJson = async () => {
    const data = await unwrap(api.GET("/api/v1/w/{workspace_id}/companies/{company_id}/export", { params: { path: { workspace_id: workspaceId, company_id: companyId } } }));
    download(`${data.name.replace(/\W+/g, "-").toLowerCase()}.octopus.json`, JSON.stringify(data, null, 2), "application/json");
    toast.success("Exported team");
  };
  const importJson = async (f: File) => {
    try {
      const body = JSON.parse(await f.text());
      const res = await unwrap(api.POST("/api/v1/w/{workspace_id}/companies/import", { params: { path: { workspace_id: workspaceId } }, body }));
      qc.setQueryData(qk.canvas(workspaceId, res.company.id), res);
      qc.setQueryData<import("@/types").CompanyOut[]>(qk.companies(workspaceId), (old) => [res.company, ...(old ?? [])]);
      void qc.invalidateQueries({ queryKey: qk.companies(workspaceId) });
      const { useApp } = await import("@/stores/app");
      useApp.getState().setCompany(workspaceId, res.company.id);
      toast.success(`Imported ${res.company.name}`);
    } catch (e) {
      toast.error("Import failed", { description: (e as Error).message });
    }
  };

  const noEntry = s.nodes.length > 0 && !s.nodes.some((n) => n.data.is_entry);
  if (q.isLoading || (q.data && s.companyId !== companyId)) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (q.isError) return <EmptyState icon={AlertCircle} title="Could not load canvas" description={(q.error as Error).message} />;

  return (
    <div className={`flex h-full${embedded ? " conversation-embedded-canvas" : ""}`}
      style={canvasStyle}>
      {!embedded && <Palette onAdd={(k) => addRole(k)} />}
      <div className="relative min-w-0 flex-1" ref={wrapper}
        tabIndex={embedded ? 0 : undefined} aria-label={embedded ? "Canvas editor" : undefined}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(DND_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(e) => { const k = e.dataTransfer.getData(DND_MIME); if (k) { e.preventDefault(); addRole(k, { x: e.clientX, y: e.clientY }); } }}>
        <ContextMenu onOpenChange={(o) => !o && setMenuNode(null)}>
          <ContextMenuTrigger asChild>
            <div className="h-full w-full" onContextMenu={(e) => { menuPos.current = { x: e.clientX, y: e.clientY }; }}>
              <LiveContext.Provider value={embedded ? overlay : null}>
              <EdgeAnchorsProvider>
              <ReactFlow<AgentNodeT, ChannelEdgeT>
                nodes={s.nodes} edges={s.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                onNodesChange={s.onNodesChange} onEdgesChange={s.onEdgesChange}
                onConnect={(c) => { const r = s.onConnect(c); if (!r.ok && r.reason) toast.error(r.reason); }}
                isValidConnection={(c) => c.source !== c.target}
                onNodeClick={(_, n) => s.setQuickConfig(n.id)}
                onPaneClick={() => { s.setQuickConfig(null); s.setEdgeEdit(null); if (embedded) wrapper.current?.focus({ preventScroll: true }); }}
                onEdgeClick={(_, e) => s.setEdgeEdit(e.id)}
                onNodeDragStart={() => s.checkpoint()}
                onNodeContextMenu={(_, n) => setMenuNode(n)}
                connectionMode={ConnectionMode.Loose}
                snapToGrid={s.snapToGrid} snapGrid={[20, 20]}
                deleteKeyCode={["Delete", "Backspace"]} multiSelectionKeyCode={["Shift", "Meta", "Control"]} selectionOnDrag={false}
                panOnScroll zoomOnPinch minZoom={0.2} maxZoom={2} proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{ type: "channel" }}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="hsl(var(--grid))" />
                <DepartmentZones departments={s.departments} onSelect={(d) => {
                  const ids = s.nodes.filter((n) => n.data.department === d).map((n) => n.id);
                  useCanvas.setState({ nodes: useCanvas.getState().nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })) });
                }} />
                <Controls showInteractive={false} position="bottom-left" fitViewOptions={fitOptions} />
                <CanvasMiniMap departments={s.departments} position={embedded ? "top-right" : "bottom-right"} onPick={(id) => useCanvas.setState({ nodes: useCanvas.getState().nodes.map((n) => ({ ...n, selected: n.id === id })) })} />
              </ReactFlow>
              </EdgeAnchorsProvider>
              </LiveContext.Provider>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {menuNode ? (
              <>
                <ContextMenuLabel>{menuNode.data.name}</ContextMenuLabel>
                <ContextMenuItem onSelect={() => s.setQuickConfig(menuNode.id)}><Settings2 />Configure</ContextMenuItem>
                <ContextMenuItem onSelect={() => s.setInspector(menuNode.id)}><Maximize />Open inspector</ContextMenuItem>
                <ContextMenuItem onSelect={() => nav(`/w/${workspaceId}/chat?agent=${menuNode.id}`)}><MessageSquare />Chat with agent</ContextMenuItem>
                <ContextMenuItem onSelect={() => s.setEntry(menuNode.id, !menuNode.data.is_entry)}><Flag />{menuNode.data.is_entry ? "Remove as team lead" : "Make team lead"}</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => s.duplicate([menuNode.id])}><CopyPlus />Duplicate<span className="ml-auto kbd">Ctrl D</span></ContextMenuItem>
                <ContextMenuItem destructive onSelect={() => s.deleteNodes([menuNode.id])}><Trash2 />Delete<span className="ml-auto kbd">Del</span></ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuSub>
                  <ContextMenuSubTrigger><Plus className="h-4 w-4 text-muted-foreground" />Add agent here</ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {roles.data?.map((r) => (
                      <ContextMenuItem key={r.key} onSelect={() => addRole(r.key, menuPos.current ?? undefined)}>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: tone(r.color) }} />{r.role}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem disabled={!s.clipboard} onSelect={() => menuPos.current && s.paste(rf.screenToFlowPosition(menuPos.current))}><ClipboardPaste />Paste<span className="ml-auto kbd">Ctrl V</span></ContextMenuItem>
                <ContextMenuItem onSelect={() => s.selectAll()}><MousePointerSquareDashed />Select all<span className="ml-auto kbd">Ctrl A</span></ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => { s.autoLayout(); setTimeout(() => fitCanvas(400), 30); }}><LayoutGrid />Tidy up</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {/* toolbar */}
        {!embedded && <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-2">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-elevated/95 p-1 shadow-lg backdrop-blur">
            <SaveIndicator state={autosave.state} error={autosave.error} savedAt={autosave.savedAt} onRetry={() => void autosave.saveNow()} />
            <Divider />
            <ToolBtn tip="Undo (Ctrl+Z)" onClick={s.undo} disabled={!s.past.length}><Undo2 /></ToolBtn>
            <ToolBtn tip="Redo (Ctrl+Y)" onClick={s.redo} disabled={!s.future.length}><Redo2 /></ToolBtn>
            <Divider />
            <ToolBtn tip="Tidy up: arrange agents by department" onClick={() => { s.autoLayout(); setTimeout(() => fitCanvas(400), 30); }}><LayoutGrid /></ToolBtn>
            <Divider />
            <Tip content="Add a department: a manager plus a small team" side="bottom">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setDeptOpen(true)} aria-label="Add department"><Building2 />Department</Button>
            </Tip>
            <ToolBtn tip="Save as template" onClick={() => setTplOpen(true)} disabled={!s.nodes.length}><BookmarkPlus /></ToolBtn>
            <DropdownMenu>
              <Tip content="More actions" side="bottom">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More actions"><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); s.toggleSnap(); }}><Grid3x3 />Snap to grid{s.snapToGrid && <Check className="ml-auto !text-primary" />}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void exportJson()}><Download />Export team (JSON)</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => fileRef.current?.click()}><Upload />Import team (JSON)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            {noEntry && (
              <Tip content="Mark one agent as the team lead (flag): it plans every request. Without one, the top of the org chart leads.">
                <span className="flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"><Flag className="h-3 w-3" />No team lead</span>
              </Tip>
            )}
            <span className="rounded-md border border-border bg-elevated/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">{s.nodes.length} {s.nodes.length === 1 ? "agent" : "agents"} · {s.edges.length} {s.edges.length === 1 ? "channel" : "channels"}</span>
            <Button onClick={talkToTeam} disabled={!s.nodes.length} className="shadow-lg" data-testid="talk-to-team"><MessageSquare />Talk to the team</Button>
          </div>
        </div>}

        {embedded && <div className="conversation-canvas-toolbar">
          <div className="canvas-toolbar-actions">
            <span className="canvas-toolbar-title">Team</span>
            <SaveIndicator state={autosave.state} error={autosave.error} savedAt={autosave.savedAt} onRetry={() => void autosave.saveNow()} />
            <Divider />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="Team actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onSelect={() => setDeptOpen(true)}><Building2 />Add department</DropdownMenuItem>
                {roles.data?.map((role) => <DropdownMenuItem key={role.key} onSelect={() => addRole(role.key)}><Plus />Add {role.role}</DropdownMenuItem>)}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => { s.autoLayout(); requestAnimationFrame(() => fitCanvas(300)); }}><LayoutGrid />Tidy up</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>}

        {s.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-xl border border-dashed border-border bg-surface/80 p-6 text-center backdrop-blur animate-fade-up">
              <Network className="mx-auto mb-2 h-6 w-6 text-primary" />
              <p className="text-sm font-medium">Your canvas is empty</p>
              <p className="text-xs text-muted-foreground">{embedded ? "Send a request and the team lead hires the agents it needs, or add one from Team actions." : <>Add a <b>Department</b> from the toolbar, or drag a role from <b>Roles</b> on the left.</>}</p>
            </div>
          </div>
        )}
        {!embedded && <div className="pointer-events-none absolute bottom-3 left-14 z-10">
          <GettingStarted onRun={s.nodes.length ? talkToTeam : undefined} />
        </div>}
        <EdgeEditor />
      </div>
      {embedded ? <div className="conversation-canvas-inspector"><Inspector /></div> : <Inspector />}
      <DepartmentBuilder open={deptOpen} onOpenChange={setDeptOpen} />
      <SaveTemplateDialog open={tplOpen} onOpenChange={setTplOpen} companyId={companyId} defaultName={q.data?.company.name ?? "Team"} flush={autosave.saveNow} />
    </div>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" />;
}

function ToolBtn({ tip, children, onClick, disabled, active }: { tip: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <Tip content={tip} side="bottom">
      <Button variant="ghost" size="icon-sm" onClick={onClick} disabled={disabled} aria-label={tip} aria-pressed={active} className={active ? "text-primary" : undefined}>{children}</Button>
    </Tip>
  );
}

function SaveIndicator({ state, error, savedAt, onRetry }: { state: SaveState; error: string | null; savedAt: Date | null; onRetry: () => void }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 15000); return () => clearInterval(t); }, []);
  const view = {
    saved: { icon: <Check className="h-3.5 w-3.5 text-success" />, text: savedAt ? `Saved ${timeAgo(savedAt)}` : "Saved" },
    dirty: { icon: <Cloud className="h-3.5 w-3.5 text-muted-foreground" />, text: "Unsaved changes" },
    saving: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />, text: "Saving…" },
    error: { icon: <CloudOff className="h-3.5 w-3.5 text-destructive" />, text: "Save failed · retry" },
    conflict: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-warning" />, text: "Syncing team…" },
  }[state];
  return (
    <Tip content={error ?? "Changes save automatically to .octopus/"} side="bottom">
      <button onClick={state === "error" ? onRetry : undefined} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition hover:bg-accent" aria-live="polite">
        {view.icon}<span className="w-[92px] truncate text-left">{view.text}</span>
      </button>
    </Tip>
  );
}

export type { CanvasOut };
