import * as React from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2, ChevronsUpDown, FileCode2, FolderOpen, History, Home, MessagesSquare, Moon, Network, Pencil, Plus, Settings, Sun, Trash2, Check, Radio,
  BookOpen, Sparkles, CircleCheck,
} from "lucide-react";
import { useCompanies, useCompanyId, useRuns, useSettings, useWorkspace, useWorkspaces, useWorkspaceId, qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";
import type { PermissionLevel } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import {
  ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, Tip,
} from "@/components/ui/overlays";
import { ErrorBoundary, PermissionBadge } from "@/components/common";
import { DirectoryPicker } from "@/features/workspaces/DirectoryPicker";
import { NewCompanyDialog } from "@/features/workspaces/NewCompanyDialog";

/** The four places you work in, in the order you usually need them. Settings and the Guide live on the right. */
const NAV = [
  { to: "canvas", label: "Canvas", hint: "Design your team of agents", icon: Network, shortcut: "1" },
  { to: "chat", label: "Chat", hint: "Talk to one agent directly", icon: MessagesSquare, shortcut: "2" },
  { to: "runs", label: "Runs", hint: "Watch the team work on a goal", icon: History, shortcut: "3" },
  { to: "artifacts", label: "Artifacts", hint: "Files and code the team produced", icon: FileCode2, shortcut: "4" },
];
const SIDE_NAV = [
  { to: "guide", label: "Guide", hint: "How everything works", icon: BookOpen, shortcut: "6" },
  { to: "settings", label: "Settings", hint: "Models, MCP, templates, project", icon: Settings, shortcut: "5" },
];
const ALL_NAV = [...NAV, ...SIDE_NAV];

export function AppShell() {
  const w = useWorkspaceId();
  const ws = useWorkspace(w);
  const nav = useNavigate();
  const loc = useLocation();
  const { theme, toggleTheme } = useApp();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const item = ALL_NAV.find((n) => n.shortcut === e.key);
      if (item) { e.preventDefault(); nav(`/w/${w}/${item.to}`); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, w]);

  if (ws.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">This project could not be opened</p>
        <p className="max-w-md text-sm text-muted-foreground">{(ws.error as Error).message}</p>
        <Button asChild variant="outline"><Link to="/"><Home />All projects</Link></Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
        <Link to="/" className="flex items-center gap-2 rounded-md px-1 py-1 transition hover:bg-accent" aria-label="All projects">
          <img src="/octopus.svg" alt="" className="h-6 w-6" />
          <span className="hidden text-sm font-semibold tracking-tight lg:inline">Octopus</span>
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <ProjectSwitcher />
        <span className="text-muted-foreground/50">/</span>
        <CompanySwitcher />
        <nav className="ml-3 flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5" aria-label="Main">
          {NAV.map((item) => <NavItem key={item.to} {...item} active={loc.pathname.includes(`/${item.to}`)} />)}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <LiveRunsIndicator />
          <ModelStatus />
          {ws.data && <PermissionBadge level={ws.data.default_permission as PermissionLevel} />}
          <span className="mx-1 h-5 w-px bg-border" />
          {SIDE_NAV.map((item) => <NavItem key={item.to} {...item} active={loc.pathname.includes(`/${item.to}`)} compact />)}
          <Tip content={theme === "dark" ? "Light theme" : "Dark theme"} side="bottom">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </Tip>
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <ErrorBoundary label="This view crashed"><Outlet /></ErrorBoundary>
      </main>
    </div>
  );
}

function NavItem({ to, label, hint, icon: Icon, shortcut, active, compact }: { to: string; label: string; hint: string; icon: typeof Network; shortcut: string; active: boolean; compact?: boolean }) {
  return (
    <Tip content={<span>{hint} <kbd className="kbd ml-1">Alt+{shortcut}</kbd></span>} side="bottom">
      <NavLink to={to} aria-label={label} className={cn(
        "relative flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
        compact && "px-2.5",
        active ? "bg-card text-foreground shadow-sm" : "hover:bg-accent")}>
        <Icon className="h-4 w-4" /><span className={cn("hidden", compact ? "xl:inline" : "md:inline")}>{label}</span>
      </NavLink>
    </Tip>
  );
}

/** One glance: are agents using a real model, or the offline demo? Click → Settings → Providers. */
function ModelStatus() {
  const { data } = useSettings();
  if (!data) return null;
  const ready = data.providers.filter((p) => p.provider !== "mock" && p.configured);
  return (
    <Tip content={ready.length ? `Connected: ${ready.map((p) => p.label).join(", ")}` : "No model connected. Agents use the offline demo. Click to connect Azure OpenAI or another provider."} side="bottom">
      <Link to="settings#providers" className={cn("hidden items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-accent sm:flex",
        ready.length ? "border-success/40 text-success" : "border-primary/40 bg-primary/10 text-primary")}>
        {ready.length ? <CircleCheck className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
        {ready.length ? ready[0].label : <>Demo mode<span className="hidden 2xl:inline">&nbsp;· connect a model</span></>}
      </Link>
    </Tip>
  );
}

function ProjectSwitcher() {
  const w = useWorkspaceId();
  const { data: list } = useWorkspaces();
  const { data: ws } = useWorkspace(w);
  const nav = useNavigate();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex max-w-[200px] items-center gap-1.5 rounded-md px-2 py-1 text-sm transition hover:bg-accent" aria-label="Switch project">
            <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate font-medium">{ws?.name ?? <span className="skeleton inline-block h-3 w-20" />}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          {list?.map((p) => (
            <DropdownMenuItem key={p.id} onSelect={() => nav(`/w/${p.id}/canvas`)} disabled={!p.exists}>
              <FolderOpen />
              <div className="min-w-0 flex-1"><div className="truncate">{p.name}</div><div className="truncate font-mono text-[10px] text-muted-foreground">{p.path}</div></div>
              {p.id === w && <Check className="!text-primary" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpen(true)}><Plus />Open another folder…</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => nav("/")}><Home />All projects</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DirectoryPicker open={open} onOpenChange={setOpen} />
    </>
  );
}

function CompanySwitcher() {
  const w = useWorkspaceId();
  const { data: companies, isLoading } = useCompanies(w);
  const { companyId, setCompanyId } = useCompanyId();
  const current = companies?.find((c) => c.id === companyId);
  const [creating, setCreating] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [name, setName] = React.useState("");
  const qc = useQueryClient();
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/w/{workspace_id}/companies/{company_id}", { params: { path: { workspace_id: w, company_id: companyId } }, body: { name } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.companies(w) }); qc.invalidateQueries({ queryKey: qk.canvas(w, companyId) }); setRenaming(false); toast.success("Renamed"); },
  });
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/api/v1/w/{workspace_id}/companies/{company_id}", { params: { path: { workspace_id: w, company_id: companyId } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.companies(w) }); toast.success(`Deleted ${current?.name}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (isLoading) return <span className="skeleton h-4 w-28" />;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-sm transition hover:bg-accent" aria-label="Switch company" data-testid="company-switcher">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">{current?.name ?? "No company"}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Companies in this project</DropdownMenuLabel>
          {companies?.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => setCompanyId(c.id)}>
              <Building2 /><span className="flex-1 truncate">{c.name}</span>
              <span className="text-[10px] text-muted-foreground">{c.agent_count}</span>
              {c.id === companyId && <Check className="!text-primary" />}
            </DropdownMenuItem>
          ))}
          {!!companies?.length && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => setCreating(true)}><Plus />New company…</DropdownMenuItem>
          {current && <DropdownMenuItem onSelect={() => { setName(current.name); setRenaming(true); }}><Pencil />Rename</DropdownMenuItem>}
          {current && <DropdownMenuItem destructive onSelect={() => setDeleting(true)}><Trash2 />Delete company</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Rename company</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate(); }} className="space-y-3">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <div className="flex justify-end"><Button type="submit" loading={rename.isPending}>Save</Button></div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} title={`Delete ${current?.name}?`} destructive confirmLabel="Delete"
        description="All agents, channels, chats and run history of this company will be removed from .octopus. Files in your project are not touched."
        onConfirm={() => del.mutate()} />
    </>
  );
}

function LiveRunsIndicator() {
  const w = useWorkspaceId();
  const { data } = useRuns(w, undefined, true);
  const live = data?.filter((r) => ["running", "paused", "awaiting_user", "queued"].includes(r.status)) ?? [];
  if (!live.length) return null;
  const needsYou = live.some((r) => r.status === "awaiting_user");
  const first = live.find((r) => r.status === "awaiting_user") ?? live[0];
  return (
    <Tip content={needsYou ? "A run is waiting for you" : `${live.length} live run(s)`} side="bottom">
      <Link to={`/w/${w}/runs/${first.id}`} className={cn("flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-accent",
        needsYou ? "border-warning/50 bg-warning/10 text-warning" : "border-primary/40 bg-primary/10 text-primary")}>
        <Radio className={cn("h-3 w-3", !needsYou && "animate-pulse")} />
        {needsYou ? "Needs you" : `${live.length} live`}
      </Link>
    </Tip>
  );
}
