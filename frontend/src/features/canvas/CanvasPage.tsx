import * as React from "react";
import {
  Background, BackgroundVariant, ConnectionMode, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle, Check, ClipboardPaste, Cloud, CloudOff, Copy, Download, Flag, Grid3x3, LayoutGrid, Loader2, Maximize, MessageSquare, Network, Play,
  Plus, Redo2, Settings2, Trash2, Undo2, Upload, Wand2, CopyPlus, MousePointerSquareDashed, Building2, BookmarkPlus,
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
  ContextMenuTrigger, Tip,
} from "@/components/ui/overlays";
import { NewCompanyDialog } from "@/features/workspaces/NewCompanyDialog";
import { RunDialog } from "@/features/runs/RunDialog";
import { edgeTypes, nodeTypes } from "./flowTypes";
import { DepartmentBuilder } from "./DepartmentBuilder";
import { DepartmentZones } from "./DepartmentZones";
import { SaveTemplateDialog } from "./SaveTemplateDialog";
import { EdgeEditor } from "./EdgeEditor";
import { Inspector } from "./Inspector";
import { DND_MIME, Palette } from "./Palette";
import { useAutosave, type SaveState } from "./useAutosave";


export default function CanvasPage() {
  const w = useWorkspaceId();
  const { companyId, loading } = useCompanyId();
  const [creating, setCreating] = React.useState(false);
  if (loading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!companyId) {
    return (
      <>
        <EmptyState icon={Network} title="No company in this project yet"
          description="A company is a team of AI agents wired together on a canvas. Start from the Software Startup template or a blank canvas."
          action={<Button onClick={() => setCreating(true)} data-testid="new-company"><Plus />Create company</Button>} />
        <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      </>
    );
  }
  return <ReactFlowProvider><CanvasEditor key={`${w}:${companyId}`} workspaceId={w} companyId={companyId} /></ReactFlowProvider>;
}

function CanvasEditor({ workspaceId, companyId }: { workspaceId: string; companyId: string }) {
  const q = useCanvasQuery(workspaceId, companyId);
  const s = useCanvas();
  const rf = useReactFlow();
  const roles = useRoleTemplates();
  const settings = useSettings();
  const nav = useNavigate();
  const qc = useQueryClient();
  const autosave = useAutosave(workspaceId, companyId);
  const [runOpen, setRunOpen] = React.useState(false);
  const [deptOpen, setDeptOpen] = React.useState(false);
  const [tplOpen, setTplOpen] = React.useState(false);
  const wrapper = React.useRef<HTMLDivElement>(null);
  const menuPos = React.useRef<{ x: number; y: number } | null>(null);
  const [menuNode, setMenuNode] = React.useState<AgentNodeT | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // layout effect: swap the store before paint so a stale company is never shown (or edited) for a frame
  React.useLayoutEffect(() => {
    if (!q.data) return;
    const st = useCanvas.getState();
    const unsaved = st.version !== 0 && st.version !== st.savedVersion;
    const otherCompany = st.companyId !== companyId;
    // load when switching company, or when the server has a newer team (e.g. agents hired during a run) and we have no local edits
    if (otherCompany || (!unsaved && (q.data.revision ?? 0) > st.revision)) {
      const grew = !otherCompany && q.data.agents.length > st.nodes.length;
      st.load(q.data);
      if (otherCompany) requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 300 }));
      else if (grew) toast.info("Your team grew", { description: "Agents hired teammates during a run; they're on the canvas now." });
    }
  }, [q.data, companyId, rf]);

  const defaults = React.useMemo(() => ({ provider: settings.data?.default_provider ?? "mock", model: settings.data?.default_model ?? "mock/demo" }), [settings.data]);
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
  }, []);

  const exportJson = async () => {
    const data = await unwrap(api.GET("/api/v1/w/{workspace_id}/companies/{company_id}/export", { params: { path: { workspace_id: workspaceId, company_id: companyId } } }));
    download(`${data.name.replace(/\W+/g, "-").toLowerCase()}.octopus.json`, JSON.stringify(data, null, 2), "application/json");
    toast.success("Exported company");
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
    <div className="flex h-full">
      <Palette onAdd={(k) => addRole(k)} onAddDepartment={() => setDeptOpen(true)} />
      <div className="relative min-w-0 flex-1" ref={wrapper}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(DND_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
        onDrop={(e) => { const k = e.dataTransfer.getData(DND_MIME); if (k) { e.preventDefault(); addRole(k, { x: e.clientX, y: e.clientY }); } }}>
        <ContextMenu onOpenChange={(o) => !o && setMenuNode(null)}>
          <ContextMenuTrigger asChild>
            <div className="h-full w-full" onContextMenu={(e) => { menuPos.current = { x: e.clientX, y: e.clientY }; }}>
              <ReactFlow<AgentNodeT, ChannelEdgeT>
                nodes={s.nodes} edges={s.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
                onNodesChange={s.onNodesChange} onEdgesChange={s.onEdgesChange}
                onConnect={(c) => { const r = s.onConnect(c); if (!r.ok && r.reason) toast.error(r.reason); }}
                isValidConnection={(c) => c.source !== c.target}
                onNodeClick={(_, n) => s.setQuickConfig(n.id)}
                onPaneClick={() => { s.setQuickConfig(null); s.setEdgeEdit(null); }}
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
                <Controls showInteractive={false} position="bottom-left" />
                <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.data as { color?: string }).color ?? "#888"} nodeBorderRadius={8} maskColor="hsl(var(--background) / 0.7)" />
              </ReactFlow>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {menuNode ? (
              <>
                <ContextMenuLabel>{menuNode.data.name}</ContextMenuLabel>
                <ContextMenuItem onSelect={() => s.setQuickConfig(menuNode.id)}><Settings2 />Configure</ContextMenuItem>
                <ContextMenuItem onSelect={() => s.setInspector(menuNode.id)}><Maximize />Open inspector</ContextMenuItem>
                <ContextMenuItem onSelect={() => nav(`/w/${workspaceId}/chat?agent=${menuNode.id}`)}><MessageSquare />Chat with agent</ContextMenuItem>
                <ContextMenuItem onSelect={() => s.setEntry(menuNode.id, !menuNode.data.is_entry)}><Flag />{menuNode.data.is_entry ? "Unset entry" : "Set as entry"}</ContextMenuItem>
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
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />{r.role}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuItem disabled={!s.clipboard} onSelect={() => menuPos.current && s.paste(rf.screenToFlowPosition(menuPos.current))}><ClipboardPaste />Paste<span className="ml-auto kbd">Ctrl V</span></ContextMenuItem>
                <ContextMenuItem onSelect={() => s.selectAll()}><MousePointerSquareDashed />Select all<span className="ml-auto kbd">Ctrl A</span></ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => { s.autoLayout(); setTimeout(() => rf.fitView({ padding: 0.2, duration: 400 }), 30); }}><Wand2 />Auto-layout</ContextMenuItem>
                <ContextMenuItem onSelect={() => rf.fitView({ padding: 0.2, duration: 300 })}><Maximize />Fit view</ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {/* toolbar */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-start justify-between gap-2">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-border bg-elevated/95 p-1 shadow-lg backdrop-blur">
            <SaveIndicator state={autosave.state} error={autosave.error} savedAt={autosave.savedAt} onRetry={() => void autosave.saveNow()} />
            <Divider />
            <ToolBtn tip="Undo (Ctrl+Z)" onClick={s.undo} disabled={!s.past.length}><Undo2 /></ToolBtn>
            <ToolBtn tip="Redo (Ctrl+Y)" onClick={s.redo} disabled={!s.future.length}><Redo2 /></ToolBtn>
            <Divider />
            <ToolBtn tip="Copy (Ctrl+C)" onClick={() => s.copy()} disabled={!s.nodes.some((n) => n.selected)}><Copy /></ToolBtn>
            <ToolBtn tip="Auto-layout" onClick={() => { s.autoLayout(); setTimeout(() => rf.fitView({ padding: 0.2, duration: 400 }), 30); }}><LayoutGrid /></ToolBtn>
            <ToolBtn tip={s.snapToGrid ? "Snap to grid: on" : "Snap to grid: off"} onClick={s.toggleSnap} active={s.snapToGrid}><Grid3x3 /></ToolBtn>
            <ToolBtn tip="Fit view" onClick={() => rf.fitView({ padding: 0.2, duration: 300 })}><Maximize /></ToolBtn>
            <Divider />
            <ToolBtn tip="Add department" onClick={() => setDeptOpen(true)}><Building2 /></ToolBtn>
            <ToolBtn tip="Save as template" onClick={() => setTplOpen(true)} disabled={!s.nodes.length}><BookmarkPlus /></ToolBtn>
            <Divider />
            <ToolBtn tip="Export JSON" onClick={() => void exportJson()}><Download /></ToolBtn>
            <ToolBtn tip="Import JSON" onClick={() => fileRef.current?.click()}><Upload /></ToolBtn>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />
          </div>
          <div className="pointer-events-auto flex items-center gap-2">
            {noEntry && (
              <Tip content="The goal is delivered to entry agents. Without one, the first root agent is used.">
                <span className="flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"><Flag className="h-3 w-3" />No entry agent</span>
              </Tip>
            )}
            <span className="rounded-md border border-border bg-elevated/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">{s.nodes.length} agents · {s.edges.length} channels</span>
            <Button onClick={() => { void autosave.saveNow(); setRunOpen(true); }} disabled={!s.nodes.length} className="shadow-lg" data-testid="run-company"><Play />Run</Button>
          </div>
        </div>

        {s.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="rounded-xl border border-dashed border-border bg-surface/80 p-6 text-center backdrop-blur animate-fade-up">
              <Network className="mx-auto mb-2 h-6 w-6 text-primary" />
              <p className="text-sm font-medium">Drag an agent from the palette</p>
              <p className="text-xs text-muted-foreground">or right-click the canvas → Add agent here</p>
            </div>
          </div>
        )}
        <EdgeEditor />
      </div>
      <Inspector />
      <RunDialog open={runOpen} onOpenChange={setRunOpen} companyId={companyId} />
      <DepartmentBuilder open={deptOpen} onOpenChange={setDeptOpen} />
      <SaveTemplateDialog open={tplOpen} onOpenChange={setTplOpen} companyId={companyId} defaultName={q.data?.company.name ?? "Company"} flush={autosave.saveNow} />
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
