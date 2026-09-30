import * as React from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2, ChevronsUpDown, FileCode2, FolderOpen, History, Home, MessagesSquare, Moon, Network, Pencil, Plus, Settings, Sun, Trash2, Check, Radio,
} from "lucide-react";
import { useCompanies, useCompanyId, useRuns, useWorkspace, useWorkspaces, useWorkspaceId, qk } from "@/hooks/queries";
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

const NAV = [
  { to: "canvas", label: "Canvas", icon: Network, key: "1" },
  { to: "chat", label: "Chat", icon: MessagesSquare, key: "2" },
  { to: "runs", label: "Runs", icon: History, key: "3" },
  { to: "artifacts", label: "Artifacts", icon: FileCode2, key: "4" },
  { to: "settings", label: "Settings", icon: Settings, key: "5" },
];

export function AppShell() {
  const w = useWorkspaceId();
  const ws = useWorkspace(w);
  const nav = useNavigate();
  const loc = useLocation();
  const { theme, toggleTheme } = useApp();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const item = NAV.find((n) => n.key === e.key);
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
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/80 px-3 backdrop-blur">
        <Link to="/" className="flex items-center gap-2 rounded-md px-1 py-1 transition hover:bg-accent" aria-label="All projects">
          <img src="/octopus.svg" alt="" className="h-6 w-6" />
          <span className="hidden text-sm font-semibold tracking-tight lg:inline">Octopus</span>
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <ProjectSwitcher />
        <span className="text-muted-foreground/50">/</span>
        <CompanySwitcher />
        <nav className="ml-3 flex items-center gap-0.5" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, key }) => (
            <Tip key={to} content={<span>{label} <kbd className="kbd ml-1">Alt+{key}</kbd></span>} side="bottom">
              <NavLink to={to} className={({ isActive }) => cn(
                "relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                (isActive || loc.pathname.includes(`/${to}`)) && "bg-accent text-foreground")}>
                <Icon className="h-4 w-4" /><span className="hidden md:inline">{label}</span>
              </NavLink>
            </Tip>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <LiveRunsIndicator />
          {ws.data && <PermissionBadge level={ws.data.default_permission as PermissionLevel} />}
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
      <Link to={`/w/${w}/runs/${first.id}`} className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition hover:bg-accent",
        needsYou ? "border-warning/50 bg-warning/10 text-warning" : "border-primary/40 bg-primary/10 text-primary")}>
        <Radio className={cn("h-3 w-3", !needsYou && "animate-pulse")} />
        {needsYou ? "Needs you" : `${live.length} live`}
      </Link>
    </Tip>
  );
}
