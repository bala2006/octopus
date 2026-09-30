import "@/lib/monaco";
import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { toast } from "sonner";
import {
  ChevronRight, Download, Eye, FileCode2, FilePlus2, FilePen, FolderClosed, FolderOpen, GitCompare, History, ListChecks, Loader2, RotateCcw, Search,
  ExternalLink, Code2, FolderTree,
} from "lucide-react";
import { api, fetchRaw, unwrap } from "@/lib/api";
import { cn, download, languageFor, timeAgo } from "@/lib/utils";
import { qk, useArtifacts, useCompanyId, useProjectFiles, useRun, useRuns, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { AgentOut, ArtifactOut } from "@/types";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";
import { ConfirmDialog, Select, Tabs, TabsList, TabsTrigger, Tip } from "@/components/ui/overlays";

type Source = "run" | "project";
interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; file?: { path: string; badge?: "created" | "modified" | "planned"; versions?: number } }

function buildTree(files: TreeNode["file"][]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    if (!f) continue;
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (!cur.children.has(p)) cur.children.set(p, { name: p, path, children: new Map() });
      cur = cur.children.get(p)!;
      if (i === parts.length - 1) cur.file = f;
    });
  }
  return root;
}

export default function ArtifactsPage() {
  const w = useWorkspaceId();
  const { runId } = useParams();
  const nav = useNavigate();
  const { companyId } = useCompanyId();
  const runs = useRuns(w, companyId || undefined);
  const [source, setSource] = React.useState<Source>(runId ? "run" : "run");
  const selectedRun = runId ?? runs.data?.[0]?.id ?? "";
  const run = useRun(w, selectedRun);
  const arts = useArtifacts(w, source === "run" ? selectedRun : "");
  const project = useProjectFiles(w);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState<number | null>(null);
  const [mode, setMode] = React.useState<"view" | "diff" | "preview">("view");
  const [q, setQ] = React.useState("");
  const theme = useApp((s) => s.theme);
  const agents = React.useMemo(() => Object.fromEntries(((run.data?.snapshot as { agents?: AgentOut[] })?.agents ?? []).map((a) => [a.id, a])), [run.data]);

  const byPath = React.useMemo(() => {
    const m = new Map<string, ArtifactOut[]>();
    for (const a of arts.data ?? []) m.set(a.path, [...(m.get(a.path) ?? []), a]);
    return m;
  }, [arts.data]);
  const files = React.useMemo(() => {
    const list = source === "run"
      ? [...byPath.entries()].map(([path, vs]) => ({ path, versions: vs.length, badge: vs[0].planned ? ("planned" as const) : undefined }))
      : (project.data ?? []).map((f) => ({ path: f.path, badge: byPath.has(f.path) ? ("modified" as const) : undefined }));
    return list.filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
  }, [source, byPath, project.data, q]);
  const tree = React.useMemo(() => buildTree(files), [files]);

  React.useEffect(() => { setSelected(null); setVersion(null); }, [selectedRun, source]);
  React.useEffect(() => { if (!selected && files.length) setSelected(files.find((f) => f.path.endsWith("README.md"))?.path ?? files[0].path); }, [files, selected]);

  const versions = selected ? byPath.get(selected) ?? [] : [];
  const latest = versions[versions.length - 1];
  const shownVersion = version ?? latest?.version ?? null;
  const planned = latest?.planned;

  const content = useQuery({
    queryKey: ["file", w, source, selectedRun, selected, shownVersion], enabled: !!selected,
    queryFn: async () => {
      if (source === "run" && shownVersion !== null) return (await unwrap(api.GET("/api/v1/w/{workspace_id}/runs/{run_id}/artifacts/file", { params: { path: { workspace_id: w, run_id: selectedRun }, query: { path: selected!, version: shownVersion } } }))).content;
      return (await unwrap(api.GET("/api/v1/w/{workspace_id}/files/content", { params: { path: { workspace_id: w }, query: { path: selected! } } }))).content;
    },
  });
  const baseVersion = shownVersion !== null ? shownVersion - 1 : 0;
  const base = useQuery({
    queryKey: ["file-base", w, selectedRun, selected, baseVersion], enabled: !!selected && mode === "diff" && source === "run",
    queryFn: async () => (await unwrap(api.GET("/api/v1/w/{workspace_id}/runs/{run_id}/artifacts/file", { params: { path: { workspace_id: w, run_id: selectedRun }, query: { path: selected!, version: baseVersion } } }))).content,
  });

  const qc = useQueryClient();
  const [revertTo, setRevertTo] = React.useState<number | null>(null);
  const revert = useMutation({
    mutationFn: (to: number) => unwrap(api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/artifacts/revert", { params: { path: { workspace_id: w, run_id: selectedRun } }, body: { path: selected!, to_version: to } })),
    onSuccess: (r) => { toast.success(r.status === "deleted" ? `Deleted ${r.path} (it did not exist before the run)` : `Restored ${r.path}`); qc.invalidateQueries({ queryKey: qk.files(w) }); qc.invalidateQueries({ queryKey: ["file"] }); },
  });
  const [applying, setApplying] = React.useState(false);
  const apply = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/plans/apply", { params: { path: { workspace_id: w, run_id: selectedRun } } })),
    onSuccess: (r) => { toast.success(`Applied ${r.applied.length} planned file(s) to the project`); qc.invalidateQueries({ queryKey: qk.files(w) }); },
  });
  const zip = async () => {
    const url = source === "run" ? `/api/v1/w/${w}/runs/${selectedRun}/artifacts.zip` : `/api/v1/w/${w}/files.zip`;
    const t = toast.loading("Preparing ZIP…");
    try {
      const res = await fetchRaw(url);
      download(source === "run" ? `octopus-run-${selectedRun.slice(0, 8)}.zip` : "project.zip", await res.blob(), "application/zip");
      toast.success("Download ready", { id: t });
    } catch (e) { toast.error((e as Error).message, { id: t }); }
  };
  const isHtml = !!selected && /\.html?$/i.test(selected);
  const hasPlanned = (arts.data ?? []).some((a) => a.planned);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Tabs value={source} onValueChange={(v) => setSource(v as Source)}>
          <TabsList><TabsTrigger value="run"><History />Run changes</TabsTrigger><TabsTrigger value="project"><FolderTree />Project files</TabsTrigger></TabsList>
        </Tabs>
        {source === "run" && (
          <Select ariaLabel="Run" value={selectedRun} onValueChange={(v) => nav(`/w/${w}/artifacts/${v}`)} className="h-8 w-[320px] text-xs"
            options={(runs.data ?? []).map((r) => ({ value: r.id, label: `${r.goal.slice(0, 48)}`, hint: `${r.status} · ${timeAgo(r.created_at)}` }))} placeholder="Select a run" />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {source === "run" && hasPlanned && <Button size="sm" variant="secondary" onClick={() => setApplying(true)}><ListChecks />Apply plan to project</Button>}
          <Button size="sm" variant="ghost" onClick={() => void zip()} disabled={source === "run" && !selectedRun}><Download />Download ZIP</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
          <div className="p-2"><div className="relative"><Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files" className="h-7 pl-7 text-xs" aria-label="Filter files" /></div></div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-[13px]" role="tree">
            {(arts.isLoading || project.isLoading) && <div className="space-y-1.5 p-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-5" />)}</div>}
            {!files.length && !arts.isLoading && <p className="p-4 text-center text-xs text-muted-foreground">{source === "run" ? "This run didn't write any files." : "The project is empty."}</p>}
            <TreeView node={tree} depth={0} selected={selected} onSelect={(p) => { setSelected(p); setVersion(null); setMode(/\.html?$/i.test(p) ? mode : mode === "preview" ? "view" : mode); }} />
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {!selected ? <EmptyState icon={FileCode2} title="No file selected" description="Pick a file from the tree." /> : (
            <>
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="truncate font-mono text-xs">{selected}</span>
                {planned && <Badge>planned</Badge>}
                {source === "run" && shownVersion !== null && <Badge variant="outline">v{shownVersion}{latest && shownVersion !== latest.version ? ` of ${latest.version}` : ""}</Badge>}
                <div className="ml-auto flex items-center gap-1">
                  <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
                    <TabsList>
                      <TabsTrigger value="view"><Code2 />Code</TabsTrigger>
                      <TabsTrigger value="diff" disabled={source !== "run" || shownVersion === null}><GitCompare />Diff</TabsTrigger>
                      <TabsTrigger value="preview" disabled={!isHtml || source !== "run"}><Eye />Preview</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              </div>
              <div className="relative min-h-0 flex-1">
                {content.isLoading && <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/50"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
                {content.isError && <EmptyState icon={FileCode2} title="Cannot open file" description={(content.error as Error).message} />}
                {mode === "view" && content.data !== undefined && (
                  <Editor height="100%" language={languageFor(selected)} value={content.data} theme={theme === "dark" ? "octopus-dark" : "vs"}
                    options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12.5, fontFamily: "JetBrains Mono Variable, monospace", scrollBeyondLastLine: false, wordWrap: "on", renderLineHighlight: "none" }}
                    loading={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />} />
                )}
                {mode === "diff" && content.data !== undefined && (
                  <DiffEditor height="100%" language={languageFor(selected)} original={base.data ?? ""} modified={content.data} theme={theme === "dark" ? "octopus-dark" : "vs"}
                    options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12.5, scrollBeyondLastLine: false }}
                    loading={<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />} />
                )}
                {mode === "preview" && (
                  <div className="flex h-full flex-col">
                    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
                      Sandboxed preview (scripts allowed, no network, no access to Octopus)
                      <a className="ml-auto flex items-center gap-1 hover:text-foreground" href={`/api/v1/w/${w}/runs/${selectedRun}/preview/${selected}`} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Open</a>
                    </div>
                    <iframe title="Live preview" className="min-h-0 flex-1 bg-white" sandbox="allow-scripts allow-forms" src={`/api/v1/w/${w}/runs/${selectedRun}/preview/${selected}?v=${shownVersion ?? 0}`} />
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        {source === "run" && selected && versions.length > 0 && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-border bg-surface" aria-label="Version history">
            <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-semibold"><History className="h-3.5 w-3.5" />Version history</div>
            <ol className="relative space-y-1 p-2">
              {[...versions].reverse().map((v) => {
                const a = v.author_agent_id ? agents[v.author_agent_id] : undefined;
                const on = v.version === shownVersion;
                return (
                  <li key={v.id}>
                    <button onClick={() => setVersion(v.version)} className={cn("w-full rounded-lg border p-2 text-left text-xs transition", on ? "border-primary/50 bg-primary/5" : "border-transparent hover:bg-accent/40")}>
                      <div className="flex items-center gap-1.5">
                        {a && <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={18} />}
                        <span className="font-medium">{a?.name ?? "Agent"}</span>
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">v{v.version}</span>
                      </div>
                      {v.change_note && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{v.change_note}</p>}
                      <p className="mt-1 text-[10px] text-muted-foreground/70">{timeAgo(v.created_at)} · {(v.size / 1024).toFixed(1)} KB</p>
                    </button>
                  </li>
                );
              })}
            </ol>
            {!planned && (
              <div className="space-y-1.5 border-t border-border p-3">
                <div className="text-[11px] font-medium text-muted-foreground">Restore in project</div>
                {shownVersion !== null && shownVersion !== latest?.version && <Button size="xs" variant="outline" className="w-full" onClick={() => setRevertTo(shownVersion)}><RotateCcw />Restore v{shownVersion}</Button>}
                <Button size="xs" variant="outline" className="w-full" onClick={() => setRevertTo(0)}><RotateCcw />Revert to before this run</Button>
              </div>
            )}
          </aside>
        )}
      </div>
      <ConfirmDialog open={revertTo !== null} onOpenChange={(o) => !o && setRevertTo(null)} title={revertTo === 0 ? `Revert ${selected}?` : `Restore v${revertTo}?`} destructive confirmLabel="Restore"
        description={revertTo === 0 ? "The file is restored to its content before the run (or deleted if the run created it)." : "The project file is overwritten with this version."}
        onConfirm={() => revertTo !== null && revert.mutate(revertTo)} />
      <ConfirmDialog open={applying} onOpenChange={setApplying} title="Apply the planned changes?" confirmLabel="Apply to project"
        description="Every file planned by this plan-mode run is written into your project directory." onConfirm={() => apply.mutate()} />
    </div>
  );
}

function TreeView({ node, depth, selected, onSelect }: { node: TreeNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const entries = [...node.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
  return <>{entries.map((c) => <TreeItem key={c.path} node={c} depth={depth} selected={selected} onSelect={onSelect} />)}</>;
}

function TreeItem({ node, depth, selected, onSelect }: { node: TreeNode; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const [open, setOpen] = React.useState(depth < 2);
  const pad = { paddingLeft: 8 + depth * 12 };
  if (node.file) {
    const f = node.file;
    const Icon = f.badge === "planned" ? FilePen : f.versions === 1 ? FilePlus2 : FileCode2;
    return (
      <button role="treeitem" aria-selected={selected === node.path} aria-label={`${node.name}${f.versions && f.versions > 1 ? `, ${f.versions} versions` : ""}${f.badge === "planned" ? ", planned" : ""}`} onClick={() => onSelect(node.path)} style={pad}
        className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition", selected === node.path ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
        <Icon className={cn("h-3.5 w-3.5 shrink-0", f.badge === "planned" ? "text-violet-400" : f.badge === "modified" ? "text-amber-400" : "text-emerald-400/80")} />
        <span className="truncate">{node.name}</span>
        {f.versions && f.versions > 1 && <Tip content={`${f.versions} versions`}><span className="ml-auto rounded bg-muted px-1 text-[10px] tabular-nums">{f.versions}</span></Tip>}
      </button>
    );
  }
  return (
    <div role="group">
      <button onClick={() => setOpen(!open)} style={pad} className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-muted-foreground transition hover:bg-accent/50 hover:text-foreground" aria-expanded={open}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/80" /> : <FolderClosed className="h-3.5 w-3.5 shrink-0 text-primary/80" />}
        <span className="truncate">{node.name}</span>
      </button>
      {open && <TreeView node={node} depth={depth + 1} selected={selected} onSelect={onSelect} />}
    </div>
  );
}
