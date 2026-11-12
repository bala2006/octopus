import * as React from "react";
import "./navigation.css";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  Home,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  CircleHelp,
  Plus,
  Settings,
  SquarePen,
  Sun,
  X,
  User,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  qk,
  useCompanyId,
  useRuns,
  useWorkspaceId,
  useWorkspaces,
} from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { cn, initials } from "@/lib/utils";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { ConfirmDialog, ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import type { WorkspaceOut } from "@/types";
import { AppMenuBar } from "./AppMenuBar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { useOpenFolder } from "@/features/projects/useOpenFolder";
import { threadKey, useWorkbenchStore } from "@/features/conversation/workbenchStore";
import { CommandPalette } from "./CommandPalette";

const VIEWS = [
  { to: "agent", label: "Chats", icon: MessageSquare },
  { to: "activity", label: "Activity", icon: History },
];

export function DesktopLayout({
  children,
  header,
  hideHeader = false,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
  hideHeader?: boolean;
}) {
  const location = useLocation();
  const w = useWorkspaceId();
  const { data: projects } = useWorkspaces();
  // The project sidebar is shown only on the workspace Chats view.
  const chatsView = Boolean(w) && location.pathname.split("/")[3] === "agent";
  const { theme, toggleTheme } = useApp();
  const [sidebar, setSidebar] = React.useState(() => window.innerWidth >= 768);
  const [showChats, setShowChats] = React.useState(false);
  const [mobile, setMobile] = React.useState(() => window.innerWidth < 768);
  const sidebarView = chatsView || showChats;
  const sidebarRef = React.useRef<HTMLElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const closeSidebar = React.useCallback(() => {
    setSidebar(false);
    setShowChats(false);
    if (mobile) toggleRef.current?.focus();
    else requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[aria-label="Expand navigation bar"]')?.focus());
  }, [mobile]);
  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const resize = () => {
      setMobile(media.matches);
      setSidebar(!media.matches);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  React.useEffect(() => {
    if (mobile) setSidebar(false);
  }, [location.pathname, mobile]);
  React.useEffect(() => {
    if (!mobile || !sidebar) return;
    sidebarRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-label="Close sidebar"]')
      ?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSidebar();
      }
      if (event.key !== "Tab") return;
      const elements = sidebarRef.current?.querySelectorAll<HTMLElement>(
        "a[href],button:not([disabled]),input,select",
      );
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mobile, sidebar, closeSidebar]);

  const folder = useOpenFolder();
  const navigate = useNavigate();
  const { companyId } = useCompanyId();
  const selectThread = useWorkbenchStore((st) => st.selectThread);
  const profileName = useApp((st) => st.profileName);
  const toggleProjects = () => { if (sidebarView && sidebar) closeSidebar(); else { setShowChats(true); setSidebar(true); } };
  const newConversation = () => {
    if (!w) { navigate("/"); return; }
    selectThread(threadKey(w, companyId), null);
    navigate(`/w/${w}/agent`);
  };
  const project = projects?.find((item) => item.id === w);
  // The project sidebar owns a column on desktop. Elsewhere (mobile drawer,
  // collapsed sidebar, non-chat views) the identity and actions share the bar.
  const sidebarColumn = chatsView && !mobile && sidebar;
  const identity = w ? (
    <span className="topbar-project" title={project?.name}><span>{project?.name ?? "Project"}</span></span>
  ) : null;
  const actions = w ? (
    <TopBarActions
      chatsView={chatsView}
      sidebar={sidebar}
      mobile={mobile}
      onToggleSidebar={() => setSidebar((open) => !open)}
      toggleRef={toggleRef}
    />
  ) : null;

  return (
    <div className="desktop-layout">
      <AppMenuBar onToggleSidebar={toggleProjects} onNewConversation={newConversation} onOpenFolder={folder.openPicker} />
      {folder.element}
      <nav className="activity-rail" aria-label="Main navigation">
        {chatsView && !sidebar && <Button variant="ghost" size="icon" className="rail-item rail-toggle" aria-label="Expand navigation bar" aria-expanded={false} onClick={() => setSidebar(true)}><img src="/octopus.svg" alt="" /></Button>}
        <Link to="/" aria-label="All projects" className={cn("rail-item", location.pathname === "/" && "is-active")}><Home /></Link>
        {VIEWS.map(({ to, label, icon: Icon }) => to === "agent" ? (
          <button key={to} className={cn("rail-item", sidebarView && sidebar && "is-active")} aria-label="Projects and conversations" title="Projects and conversations" aria-expanded={sidebarView && sidebar} onClick={toggleProjects}><Icon /></button>
        ) : (
          <Link key={to} to="/activity" aria-label={label} title={label} className={cn("rail-item", location.pathname === "/activity" && "is-active")}><Icon /></Link>
        ))}
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="rail-profile" aria-label="Open profile menu" title={profileName || "Your profile"}>{profileName ? <span>{initials(profileName)}</span> : <User className="h-4 w-4" />}</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="w-64">
            <DropdownMenuLabel className="flex flex-col gap-1"><span className="text-foreground">{profileName || "You"}</span><span className="font-normal">Everything stays on this computer</span></DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link to="/activity"><History />Activity and profile</Link></DropdownMenuItem>
            <DropdownMenuItem onSelect={toggleTheme}>{theme === "dark" ? <Sun /> : <Moon />}{theme === "dark" ? "Light mode" : "Dark mode"}</DropdownMenuItem>
            <DropdownMenuItem asChild><Link to={w ? `/w/${w}/settings` : "/settings"}><Settings />Settings</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link to={w ? `/w/${w}/guide` : "/guide"}><CircleHelp />Help</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
      <div className="desktop-surface">
        {sidebarView && sidebar && mobile && (
          <button
            className="sidebar-backdrop"
            tabIndex={-1}
            aria-label="Close project sidebar"
            onClick={closeSidebar}
          />
        )}
        {!hideHeader && (
          <header className="desktop-topbar">
            {sidebarColumn && (
              <div className="topbar-identity">
                <Link to="/" className="topbar-brand" aria-label="Octopus home"><img src="/octopus.svg" alt="" /><span>Octopus</span></Link>
                <span className="flex-1" />
                {actions}
              </div>
            )}
            <div className="desktop-header">
              {identity}
              {identity && (
                chatsView ? <span className="topbar-breadcrumb-separator" aria-hidden>/</span> : <span className="topbar-divider" aria-hidden />
              )}
              {header}
              {!sidebarColumn && actions}
            </div>
          </header>
        )}
        <div className="desktop-body">
          {sidebarView && (!mobile || sidebar) && (
            <ProjectSidebar
              mobile={mobile}
              sidebarCollapsed={!sidebar}
              onClose={closeSidebar}
              panelRef={sidebarRef}
            />
          )}
          <div className="desktop-main">
            <main
              id="main-content"
              className="min-h-0 min-w-0 flex-1 overflow-hidden"
            >
              {children}
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectSidebar({
  mobile,
  sidebarCollapsed,
  onClose,
  panelRef,
}: {
  mobile: boolean;
  sidebarCollapsed: boolean;
  onClose: () => void;
  panelRef: React.Ref<HTMLElement>;
}) {
  const w = useWorkspaceId();
  const location = useLocation();
  const navigate = useNavigate();
  const projects = useWorkspaces();
  const { companyId, setCompanyId } = useCompanyId();
  const target = w || projects.data?.find((project) => project.exists)?.id;
  const runs = useRuns(w, companyId || undefined, true);
  const recentRuns = useRuns(target || "", undefined, false);
  const store = useWorkbenchStore();
  const key = threadKey(w, companyId);
  const selected = store.threads[key];
  const activeRun = selected === undefined ? runs.data?.[0]?.id : selected;
  const folder = useOpenFolder();
  const [collapsed, setCollapsed] = React.useState(false);
  const filtered = [...(projects.data ?? [])]
    .sort((a, b) =>
      String(b.last_opened_at ?? "").localeCompare(
        String(a.last_opened_at ?? ""),
      ),
    )
  const newChat = () => {
    if (!w) {
      navigate("/");
      return;
    }
    store.selectThread(key, null);
    navigate(`/w/${w}/agent`);
  };
  return (
    <aside
      ref={panelRef}
      className={cn("project-sidebar", sidebarCollapsed && !mobile && "is-collapsed")}
      aria-label="Projects and conversations"
    >
      {mobile && (
        <div className="sidebar-heading">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-lg font-semibold tracking-tight"
          >
            <img src="/octopus.svg" alt="" className="h-6 w-6" />
            Octopus
          </Link>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      )}
      <button className="sidebar-new-chat" onClick={newChat}>
        <SquarePen className="h-4 w-4" />
        <span>New conversation</span>
        <Plus className="ml-auto h-3.5 w-3.5 opacity-40" />
      </button>

      <div className="sidebar-scroll">
      <nav className="sidebar-navigation sidebar-mobile-navigation" aria-label="Main navigation">
        <Link to="/" className={cn("sidebar-nav-item", !w && "is-active")}><Home /><span>All projects</span></Link>
        {VIEWS.map(({ to, label, icon: Icon }) => to === "activity" ? (
          <Link key={to} to="/activity" className={cn("sidebar-nav-item", location.pathname === "/activity" && "is-active")}><Icon /><span>{label}</span></Link>
        ) : target ? (
          <Link key={to} to={`/w/${target}/${to}`} className={cn("sidebar-nav-item", w && location.pathname.split("/")[3] === to && "is-active")}><Icon /><span>{label}</span></Link>
        ) : (
          <Link key={to} to="/" className="sidebar-nav-item"><Icon /><span>{label}</span></Link>
        ))}
        <Link to={w ? `/w/${w}/guide` : "/guide"} className="sidebar-nav-item"><BookOpen /><span>Guide</span></Link>
        <Link to={w ? `/w/${w}/settings` : "/settings"} className="sidebar-nav-item"><Settings /><span>Settings</span></Link>
      </nav>
        <div className="sidebar-section-heading">
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            className="sidebar-section-title"
          >
            Projects
            {collapsed ? <ChevronRight /> : <ChevronDown />}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add project"
            title="Add project"
            onClick={folder.openPicker}
          >
            <Plus />
          </Button>
        </div>
        {!collapsed && (
          <div className="space-y-0.5">
            {projects.isLoading && (
              <div className="px-3 space-y-2">
                <div className="skeleton h-8" />
                <div className="skeleton h-8" />
              </div>
            )}
            {projects.isError && (
              <p className="px-5 py-2 text-xs text-destructive" role="alert">
                Projects could not be loaded.{" "}
                <button
                  className="underline"
                  onClick={() => void projects.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            {filtered.map((project) => (
              <ProjectItem key={project.id} project={project} selected={w === project.id}>
                <Link
                  to={project.exists ? `/w/${project.id}/agent` : "/"}
                  aria-disabled={!project.exists}
                  onClick={(e) => {
                    if (!project.exists) {
                      e.preventDefault();
                      toast.error(`${project.name}: folder not found`, { description: `${project.path} was moved or deleted. Right-click the project to remove it from Octopus.` });
                    }
                  }}
                  className={cn(
                    "sidebar-project",
                    w === project.id && "is-selected",
                    !project.exists && "opacity-40",
                  )}
                  title={project.path}
                >
                  {w === project.id ? <FolderOpen /> : <Folder />}
                  <span>{project.name}</span>
                  {w === project.id && (
                    <ChevronDown className="!h-3 !w-3 opacity-50" />
                  )}
                </Link>
              </ProjectItem>
            ))}
            {!projects.isLoading && !projects.isError && !filtered.length && (
              <p className="px-5 py-3 text-xs text-muted-foreground">
                Open a folder to get started.
              </p>
            )}
          </div>
        )}
        <div className="sidebar-section-heading sidebar-recents-heading">
          <span>{w || !target ? "Recents" : `Recents in ${projects.data?.find((p) => p.id === target)?.name ?? "your last project"}`}</span>
        </div>
        <div className="sidebar-conversations">
          {w && selected === null && location.pathname.endsWith("/agent") && (
            <button className="sidebar-conversation is-selected" onClick={newChat}>
              <span>New conversation</span>
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            </button>
          )}
          {recentRuns.data?.slice(0, 20).map((run) => (
            <button key={run.id} className={cn("sidebar-conversation", w && activeRun === run.id && location.pathname.endsWith("/agent") && "is-selected")} title={run.goal.split("\n")[0]} onClick={() => { if (run.company_id && target) { if (w === target) setCompanyId(run.company_id); store.selectThread(threadKey(target, run.company_id), run.id); } if (target) navigate(`/w/${target}/agent`); }}>
              <span>{run.goal.split("\n")[0] || "New conversation"}</span>
              {["running", "queued", "awaiting_user"].includes(run.status) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
            </button>
          ))}
          {recentRuns.isError && <button className="px-3 py-2 text-xs text-muted-foreground" onClick={() => void recentRuns.refetch()}>Retry recents</button>}
          {target && !recentRuns.isLoading && !recentRuns.data?.length && <p className="px-3 py-2 text-xs text-muted-foreground">Recent conversations will appear here.</p>}
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

/** Notifications and quick open, plus the sidebar toggle. */
function TopBarActions({
  chatsView,
  sidebar,
  mobile,
  onToggleSidebar,
  toggleRef,
}: {
  chatsView: boolean;
  sidebar: boolean;
  mobile: boolean;
  onToggleSidebar: () => void;
  toggleRef: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <div className="topbar-actions">
      <LiveBell />
      <CommandPalette />
      {chatsView && (
        <button
          ref={toggleRef}
          type="button"
          className="topbar-action"
          aria-label={
            mobile
              ? sidebar
                ? "Hide project sidebar"
                : "Show project sidebar"
              : sidebar
                ? "Collapse navigation bar"
                : "Expand navigation bar"
          }
          aria-expanded={sidebar}
          onClick={onToggleSidebar}
        >
          {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
        </button>
      )}
    </div>
  );
}

/** One bell for team activity: amber when the team waits on you. */
function LiveBell() {
  const w = useWorkspaceId();
  const { data } = useRuns(w, undefined, true);
  const live =
    data?.filter((run) =>
      ["running", "paused", "awaiting_user", "queued"].includes(run.status),
    ) ?? [];
  const needsYou = live.some((run) => run.status === "awaiting_user");
  const first = live.find((run) => run.status === "awaiting_user") ?? live[0];
  const label = needsYou
    ? "Notifications: your team is waiting for you"
    : live.length
      ? `Notifications: ${live.length} active conversation${live.length === 1 ? "" : "s"}`
      : "Notifications";
  return (
    <Link
      to={first ? `/w/${w}/runs/${first.id}` : `/w/${w}/runs`}
      aria-label={label}
      className={cn("topbar-action", needsYou && "has-alert")}
    >
      <Bell />
      {needsYou && <span className="topbar-dot" aria-hidden />}
    </Link>
  );
}
