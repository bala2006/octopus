import * as React from "react";
import "./navigation.css";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  CircleAlert, Folder, FolderOpen, Home, Loader2, Moon, Pencil, Pin, PinOff, Plus, Settings,
  SquarePen, Sun, Trash2, User, UserRound, X,
} from "lucide-react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { qk, useCompanyId, useRuns, useWorkspaceId, useWorkspaces } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { cn, goalTitle, initials, parseUtc } from "@/lib/utils";
import { api, unwrap } from "@/lib/api";
import {
  ConfirmDialog, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import type { RunOut, WorkspaceOut } from "@/types";
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

/** Newest first: the order every conversation list in the sidebar uses. */
const newestFirst = (a: RunOut, b: RunOut) => parseUtc(b.created_at) - parseUtc(a.created_at);

const PIN_KEY = "octopus-pinned-conversations";
/** Conversations pinned to the top of the sidebar, kept on this computer. */
function usePinnedRuns(): [string[], (id: string) => void] {
  const [ids, setIds] = React.useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const toggle = React.useCallback((id: string) => {
    setIds((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      try { localStorage.setItem(PIN_KEY, JSON.stringify(next)); } catch { /* Pins still work until the page reloads. */ }
      return next;
    });
  }, []);
  return [ids, toggle];
}

/**
 * The left column: pinned conversations, every project (the open one lists its newest conversations under it) and
 * recents across all projects.
 */
function ProjectSidebar({ mobile, collapsed, onClose, onNewConversation, panelRef }: {
  mobile: boolean;
  collapsed: boolean;
  onClose: () => void;
  onNewConversation: () => void;
  panelRef: React.Ref<HTMLElement>;
}) {
  const w = useWorkspaceId();
  const location = useLocation();
  const navigate = useNavigate();
  const projects = useWorkspaces();
  const { companyId } = useCompanyId();
  const openConversation = useOpenConversation();
  const folder = useOpenFolder();
  const selected = useWorkbenchStore((s) => s.threads[threadKey(w, companyId)]);
  const onConversation = spaceOf(location.pathname)?.to === "agent";
  const [pinned, togglePin] = usePinnedRuns();
  const [openState, setOpenState] = React.useState<Record<string, boolean>>({});
  const sorted = [...(projects.data ?? [])].sort((a, b) => String(b.last_opened_at ?? "").localeCompare(String(a.last_opened_at ?? "")));
  const runQueries = useQueries({
    queries: sorted.map((p) => ({
      queryKey: qk.runs(p.id),
      enabled: p.exists,
      refetchInterval: p.id === w ? 3000 : false,
      queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/runs", { params: { path: { workspace_id: p.id }, query: {} } })),
    })),
  });
  const byProject = sorted.map((project, i) => ({
    project,
    runs: [...((runQueries[i]?.data as RunOut[] | undefined) ?? [])].sort(newestFirst),
  }));
  const everything = byProject.flatMap(({ project, runs }) => runs.map((run) => ({ run, project })));
  const pinnedItems = pinned.flatMap((id) => everything.filter((e) => e.run.id === id));
  const recents = [...everything].sort((a, b) => newestFirst(a.run, b.run)).slice(0, 8);
  const current = byProject.find((p) => p.project.id === w)?.runs ?? [];
  const activeRun = selected === undefined ? current[0]?.id : selected;
  const isOpen = (id: string) => openState[id] ?? id === w;
  // One highlight at a time: the open conversation where it is first listed (pinned, then its project, then recents).
  // While no conversation is highlighted, the current project row carries the highlight.
  const rendered = [
    ...pinnedItems.map(({ run, project }) => `pinned:${project.id}:${run.id}`),
    ...byProject.filter(({ project }) => isOpen(project.id)).flatMap(({ project, runs }) => runs.slice(0, 5).map((run) => `project:${project.id}:${run.id}`)),
    ...recents.map(({ run, project }) => `recent:${project.id}:${run.id}`),
  ];
  const highlighted = onConversation && activeRun ? rendered.find((key) => key.endsWith(`:${w}:${activeRun}`)) : undefined;

  const openProject = (project: WorkspaceOut) => {
    if (!project.exists) {
      toast.error(`${project.name}: folder not found`, { description: `${project.path} was moved or deleted. Right-click the project to remove it from Octopus.` });
      return;
    }
    if (project.id === w) {
      setOpenState((s) => ({ ...s, [project.id]: !isOpen(project.id) }));
      return;
    }
    setOpenState((s) => ({ ...s, [project.id]: true }));
    navigate(`/w/${project.id}/agent`);
  };

  const conversation = (section: "pinned" | "project" | "recent", run: RunOut, project: WorkspaceOut, child: boolean) => (
    <ConversationRow key={`${section}:${project.id}:${run.id}`} run={run} child={child} pinned={pinned.includes(run.id)}
      active={`${section}:${project.id}:${run.id}` === highlighted}
      onOpen={() => openConversation(project.id, run)} onTogglePin={() => togglePin(run.id)} />
  );

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
          <SquarePen />
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

        {pinnedItems.length > 0 && (
          <section aria-labelledby="sidebar-pinned">
            <h2 id="sidebar-pinned" className="side-heading">Pinned</h2>
            {pinnedItems.map(({ run, project }) => conversation("pinned", run, project, false))}
          </section>
        )}

        <section aria-labelledby="sidebar-projects">
          <div className="side-heading-row">
            <h2 id="sidebar-projects" className="side-heading">Projects</h2>
            <Button variant="ghost" size="icon-sm" aria-label="Open project folder" title="Open project folder" onClick={folder.openPicker}><Plus /></Button>
          </div>
          {projects.isLoading && <div className="space-y-2 px-2"><div className="skeleton h-8" /><div className="skeleton h-8" /></div>}
          {projects.isError && (
            <p className="side-empty text-destructive" role="alert">
              Projects could not be loaded. <button className="underline" onClick={() => void projects.refetch()}>Retry</button>
            </p>
          )}
          {byProject.map(({ project, runs }) => {
            const open = isOpen(project.id);
            return (
              <React.Fragment key={project.id}>
                <ProjectItem project={project} selected={project.id === w}>
                  <button type="button" className={cn("side-row", project.id === w && highlighted === undefined && "is-selected", !project.exists && "opacity-40")}
                    aria-expanded={open} aria-current={project.id === w ? "page" : undefined}
                    title={`${project.path}\nRight-click to rename or remove`} onClick={() => openProject(project)}>
                    {open ? <FolderOpen /> : <Folder />}
                    <span className="side-label">{project.name}</span>
                  </button>
                </ProjectItem>
                {open && (
                  <>
                    {runs.slice(0, 5).map((run) => conversation("project", run, project, true))}
                    {project.exists && runs.length === 0 && <p className="side-empty side-child">No conversations yet.</p>}
                    {runs.length > 5 && <Link to={`/w/${project.id}/runs`} className="side-row is-child side-more">Show more</Link>}
                  </>
                )}
              </React.Fragment>
            );
          })}
          {!projects.isLoading && !projects.isError && !sorted.length && <p className="side-empty">Open a folder to get started.</p>}
        </section>

        <section aria-labelledby="sidebar-recents">
          <h2 id="sidebar-recents" className="side-heading">Recents</h2>
          {recents.map(({ run, project }) => conversation("recent", run, project, false))}
          {!recents.length && <p className="side-empty">Your conversations will appear here.</p>}
        </section>
      </div>
      {folder.element}
    </aside>
  );
}

function ConversationRow({ run, child, active, pinned, onOpen, onTogglePin }: {
  run: RunOut;
  child: boolean;
  active: boolean;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}) {
  const title = goalTitle(run.goal);
  return (
    <div className={cn("side-row side-conversation", child && "is-child", pinned && "is-pinned", active && "is-selected")}>
      <button type="button" className="side-conversation-open" title={title} aria-current={active ? "true" : undefined} onClick={onOpen}>
        <span className="side-label">{title}</span>
      </button>
      {run.status === "awaiting_user" ? <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Waiting on you" />
        : LIVE.includes(run.status) && <span className="side-dot" aria-label="Working" />}
      <button type="button" className="side-pin" title={pinned ? "Unpin" : "Pin"} aria-label={pinned ? "Unpin conversation" : "Pin conversation"} onClick={onTogglePin}>
        {pinned ? <PinOff /> : <Pin />}
      </button>
    </div>
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
