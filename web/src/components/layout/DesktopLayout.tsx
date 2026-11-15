import * as React from "react";
import "./navigation.css";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  ChevronDown, ChevronRight, CircleAlert, Folder, FolderOpen, Home, Loader2, Moon, Pencil, Plus, Settings,
  SquarePen, Sun, Trash2, User, UserRound, X,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { qk, useCompanyId, useRuns, useWorkspaceId, useWorkspaces } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { cn, goalTitle, initials } from "@/lib/utils";
import { api, unwrap } from "@/lib/api";
import {
  ConfirmDialog, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import type { WorkspaceOut } from "@/types";
import { useOpenFolder } from "@/features/projects/useOpenFolder";
import { threadKey, useWorkbenchStore } from "@/features/conversation/workbenchStore";
import { useOpenConversation } from "@/features/conversation/useOpenConversation";
import { AppMenuBar } from "./AppMenuBar";
import { CommandPalette } from "./CommandPalette";
import { SPACES, spaceOf } from "./spaces";

const LIVE = ["running", "paused", "awaiting_user", "queued"];

/**
 * The frame around every page:
 * - the menu bar (history, the one sidebar toggle, File / Edit / View / Help);
 * - the rail: Home, the project's spaces, and your profile menu;
 * - the sidebar: projects and recent conversations;
 * - the page header: project / page title, the page's own controls, team status and quick open.
 */
export function DesktopLayout({ children, header }: {
  children: React.ReactNode;
  header: React.ReactNode;
}) {
  const location = useLocation();
  const w = useWorkspaceId();
  const { data: projects } = useWorkspaces();
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setSidebarOpen = useApp((s) => s.setSidebarOpen);
  const [mobile, setMobile] = React.useState(() => window.innerWidth < 768);
  const [drawer, setDrawer] = React.useState(false);
  const open = mobile ? drawer : sidebarOpen;
  const sidebarRef = React.useRef<HTMLElement>(null);
  const toggleSidebar = React.useCallback(() => (mobile ? setDrawer((v) => !v) : setSidebarOpen(!sidebarOpen)), [mobile, sidebarOpen, setSidebarOpen]);
  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => setMobile(media.matches);
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  React.useEffect(() => setDrawer(false), [location.pathname]);
  // On mobile the sidebar is a modal drawer: Escape closes it and Tab stays inside.
  React.useEffect(() => {
    if (!mobile || !drawer) return;
    sidebarRef.current?.querySelector<HTMLButtonElement>('button[aria-label="Close sidebar"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") { event.preventDefault(); setDrawer(false); }
      if (event.key !== "Tab") return;
      const elements = sidebarRef.current?.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input,select");
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mobile, drawer]);

  const folder = useOpenFolder();
  const { companyId } = useCompanyId();
  const openConversation = useOpenConversation();
  const navigate = useNavigate();
  const newConversation = () => (w ? openConversation(w, null, companyId) : navigate("/"));
  const project = projects?.find((item) => item.id === w);

  return (
    <div className="desktop-layout">
      <AppMenuBar onToggleSidebar={toggleSidebar} onNewConversation={newConversation} onOpenFolder={folder.openPicker} />
      {folder.element}
      <Rail />
      <div className="desktop-surface">
        {open && mobile && <button className="sidebar-backdrop" tabIndex={-1} aria-label="Close project sidebar" onClick={() => setDrawer(false)} />}
        <div className="desktop-body">
          {(!mobile || drawer) && (
            <ProjectSidebar mobile={mobile} collapsed={!open} onClose={() => setDrawer(false)} onNewConversation={newConversation} panelRef={sidebarRef} />
          )}
          <div className="desktop-main">
            <header className="desktop-topbar">
              <div className="desktop-header">
                {project && <span className="topbar-project" title={project.path}><span>{project.name}</span></span>}
                {project && <span className="topbar-breadcrumb-separator" aria-hidden>/</span>}
                {header}
                {w && <div className="topbar-actions"><TeamPulse /><CommandPalette /></div>}
              </div>
            </header>
            <main id="main-content" className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Home, then one icon per project space, then you. */
function Rail() {
  const w = useWorkspaceId();
  const location = useLocation();
  const { theme, toggleTheme } = useApp();
  const profileName = useApp((s) => s.profileName);
  return (
    <nav className="activity-rail" aria-label="Main navigation">
      <Link to="/" aria-label="Home: all projects" title="Home" className={cn("rail-item rail-home", location.pathname === "/" && "is-active")}>
        <img src="/octopus.svg" alt="" />
      </Link>
      {w && <span className="rail-divider" aria-hidden />}
      {w && SPACES.map((s) => (
        <NavLink key={s.to} to={`/w/${w}/${s.to}`} title={`${s.label} (Alt+${s.key})`}
          className={() => cn("rail-item", spaceOf(location.pathname)?.to === s.to && "is-active")}>
          <s.icon />
          <span>{s.label}</span>
        </NavLink>
      ))}
      <div className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rail-profile" aria-label="Open profile menu" title={profileName || "Your profile"}>
            {profileName ? <span>{initials(profileName)}</span> : <User className="h-4 w-4" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="right" className="w-64">
          <DropdownMenuLabel className="flex flex-col gap-1"><span className="text-foreground">{profileName || "You"}</span><span className="font-normal">Everything stays on this computer</span></DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link to="/activity"><UserRound />Profile and activity</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link to={w ? `/w/${w}/settings` : "/settings"}><Settings />Settings</Link></DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={toggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "Light mode" : "Dark mode"}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}

function ProjectSidebar({ mobile, collapsed, onClose, onNewConversation, panelRef }: {
  mobile: boolean;
  collapsed: boolean;
  onClose: () => void;
  onNewConversation: () => void;
  panelRef: React.Ref<HTMLElement>;
}) {
  const w = useWorkspaceId();
  const location = useLocation();
  const projects = useWorkspaces();
  const { companyId } = useCompanyId();
  const target = w || projects.data?.find((project) => project.exists)?.id;
  const runs = useRuns(w, companyId || undefined, true);
  const recentRuns = useRuns(target || "", undefined, false);
  const selected = useWorkbenchStore((s) => s.threads[threadKey(w, companyId)]);
  const activeRun = selected === undefined ? runs.data?.[0]?.id : selected;
  const openConversation = useOpenConversation();
  const folder = useOpenFolder();
  const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
  const onConversation = spaceOf(location.pathname)?.to === "agent";
  const sorted = [...(projects.data ?? [])].sort((a, b) => String(b.last_opened_at ?? "").localeCompare(String(a.last_opened_at ?? "")));
  const targetName = projects.data?.find((p) => p.id === target)?.name;
  return (
    <aside ref={panelRef} className={cn("project-sidebar", collapsed && !mobile && "is-collapsed")} aria-label="Projects and conversations">
      {mobile && (
        <div className="sidebar-heading">
          <Link to="/" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><img src="/octopus.svg" alt="" className="h-6 w-6" />Octopus</Link>
          <span className="flex-1" />
          <Button variant="ghost" size="icon-sm" aria-label="Close sidebar" onClick={onClose}><X /></Button>
        </div>
      )}
      <div className="sidebar-top">
        <button className="sidebar-new-chat" onClick={onNewConversation}>
          <SquarePen className="h-4 w-4" />
          <span>New conversation</span>
        </button>
      </div>

      <div className="sidebar-scroll">
        {/* On mobile the rail is hidden, so its destinations move here. */}
        <nav className="sidebar-navigation sidebar-mobile-navigation" aria-label="Main navigation">
          <Link to="/" className={cn("sidebar-nav-item", location.pathname === "/" && "is-active")}><Home /><span>Home</span></Link>
          {w && SPACES.map((s) => (
            <Link key={s.to} to={`/w/${w}/${s.to}`} className={cn("sidebar-nav-item", spaceOf(location.pathname)?.to === s.to && "is-active")}><s.icon /><span>{s.label}</span></Link>
          ))}
          <Link to={w ? `/w/${w}/settings` : "/settings"} className="sidebar-nav-item"><Settings /><span>Settings</span></Link>
        </nav>
        <div className="sidebar-section-heading">
          <button onClick={() => setProjectsCollapsed(!projectsCollapsed)} aria-expanded={!projectsCollapsed} className="sidebar-section-title">
            Projects{projectsCollapsed ? <ChevronRight /> : <ChevronDown />}
          </button>
          <Button variant="ghost" size="icon-sm" aria-label="Open project folder" title="Open project folder" onClick={folder.openPicker}><Plus /></Button>
        </div>
        {!projectsCollapsed && (
          <div className="space-y-0.5">
            {projects.isLoading && <div className="space-y-2 px-3"><div className="skeleton h-8" /><div className="skeleton h-8" /></div>}
            {projects.isError && (
              <p className="px-5 py-2 text-xs text-destructive" role="alert">
                Projects could not be loaded. <button className="underline" onClick={() => void projects.refetch()}>Retry</button>
              </p>
            )}
            {sorted.map((project) => (
              <ProjectItem key={project.id} project={project} selected={w === project.id}>
                <Link
                  to={project.exists ? `/w/${project.id}/agent` : "/"}
                  aria-disabled={!project.exists}
                  aria-current={w === project.id ? "page" : undefined}
                  onClick={(e) => {
                    if (project.exists) return;
                    e.preventDefault();
                    toast.error(`${project.name}: folder not found`, { description: `${project.path} was moved or deleted. Right-click the project to remove it from Octopus.` });
                  }}
                  className={cn("sidebar-project", w === project.id && "is-selected", !project.exists && "opacity-40")}
                  title={`${project.path}\nRight-click to rename or remove`}
                >
                  {w === project.id ? <FolderOpen /> : <Folder />}
                  <span>{project.name}</span>
                </Link>
              </ProjectItem>
            ))}
            {!projects.isLoading && !projects.isError && !sorted.length && <p className="px-5 py-3 text-xs text-muted-foreground">Open a folder to get started.</p>}
          </div>
        )}
        <div className="sidebar-section-heading sidebar-recents-heading">
          <span>{w || !targetName ? "Recent conversations" : `Recent in ${targetName}`}</span>
        </div>
        <div className="sidebar-conversations">
          {w && selected === null && onConversation && (
            <button className="sidebar-conversation is-selected" onClick={onNewConversation}><span>New conversation</span><span className="h-1.5 w-1.5 rounded-full bg-primary" /></button>
          )}
          {recentRuns.data?.slice(0, 20).map((run) => (
            <button key={run.id} className={cn("sidebar-conversation", w && activeRun === run.id && onConversation && "is-selected")} title={goalTitle(run.goal)}
              onClick={() => target && openConversation(target, run)}>
              <span>{goalTitle(run.goal)}</span>
              {run.status === "awaiting_user" ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Waiting on you" />
                : LIVE.includes(run.status) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Working" />}
            </button>
          ))}
          {recentRuns.isError && <button className="px-3 py-2 text-xs text-muted-foreground" onClick={() => void recentRuns.refetch()}>Retry</button>}
          {target && !recentRuns.isLoading && !recentRuns.data?.length && <p className="px-3 py-2 text-xs text-muted-foreground">Your conversations will appear here.</p>}
          {target && (recentRuns.data?.length ?? 0) > 20 && <Link to={`/w/${target}/runs`} className="block px-3 py-2 text-xs text-muted-foreground hover:text-foreground">See all in History</Link>}
        </div>
      </div>
      {folder.element}
    </aside>
  );
}

/** A project in the sidebar: right-click to rename it or remove it from Octopus (the folder is not touched). */
function ProjectItem({ project, selected, children }: { project: WorkspaceOut; selected: boolean; children: React.ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [renaming, setRenaming] = React.useState(false);
  const [name, setName] = React.useState(project.name);
  const [removing, setRemoving] = React.useState(false);
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: project.id } }, body: { name: name.trim() } })),
    onSuccess: () => { setRenaming(false); void qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success("Project renamed"); },
    onError: (e: Error) => toast.error("Could not rename the project", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: project.id } } })),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success(`Removed ${project.name} from Octopus`, { description: "The folder and its .octopus history are untouched; open it again to bring everything back." }); if (selected) navigate("/"); },
    onError: (e: Error) => toast.error("Could not remove the project", { description: e.message }),
  });
  if (renaming) {
    return (
      <form className="px-2 py-1" onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate(); }}>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => !rename.isPending && setRenaming(false)} onKeyDown={(e) => e.key === "Escape" && setRenaming(false)} aria-label="Project name" className="h-8" maxLength={120} />
      </form>
    );
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild><div>{children}</div></ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={!project.exists} onSelect={() => { setName(project.name); setRenaming(true); }}><Pencil />Rename</ContextMenuItem>
          <ContextMenuItem disabled={!project.exists} onSelect={() => navigate(`/w/${project.id}/settings#project`)}><Settings />Project settings</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem destructive onSelect={() => setRemoving(true)}><Trash2 />Remove from Octopus</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ConfirmDialog open={removing} onOpenChange={setRemoving} title={`Remove ${project.name}?`} destructive confirmLabel="Remove"
        description={`Octopus forgets this project. Nothing in ${project.path} is deleted, including its .octopus history.`} onConfirm={() => remove.mutate()} />
    </>
  );
}

/**
 * The one place that shows what the team is doing right now. Hidden while nothing runs; amber when the team
 * waits on you. Clicking it opens that conversation.
 */
function TeamPulse() {
  const w = useWorkspaceId();
  const { data } = useRuns(w, undefined, true);
  const openConversation = useOpenConversation();
  const live = data?.filter((run) => LIVE.includes(run.status)) ?? [];
  if (!live.length) return null;
  const waiting = live.filter((run) => run.status === "awaiting_user");
  const first = waiting[0] ?? live[0];
  const label = waiting.length ? (waiting.length === 1 ? "Needs you" : `${waiting.length} need you`)
    : live.length === 1 ? (first.status === "paused" ? "Team paused" : "Team working") : `${live.length} working`;
  return (
    <button type="button" className={cn("team-pulse", waiting.length && "is-waiting")} onClick={() => openConversation(w, first)}
      title={`${goalTitle(first.goal)}: open the conversation`} aria-label={`${label}: open the conversation`}>
      {waiting.length ? <CircleAlert /> : first.status === "paused" ? <span className="team-pulse-dot" /> : <Loader2 className="animate-spin" />}
      <span>{label}</span>
    </button>
  );
}
