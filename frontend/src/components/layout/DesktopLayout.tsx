import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
  History,
  Home,
  MessageSquare,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  SquarePen,
  Sun,
  X,
} from "lucide-react";
import {
  useCompanies,
  useCompanyId,
  useRuns,
  useWorkspaceId,
  useWorkspaces,
} from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/overlays";
import { useOpenFolder } from "@/features/workspaces/useOpenFolder";
import { threadKey, useWorkbenchStore } from "@/features/editor/workbenchStore";

const VIEWS = [
  { to: "agent", label: "Conversations", icon: MessageSquare },
  { to: "workspace", label: "Workspace", icon: FileCode2 },
  { to: "canvas", label: "Team canvas", icon: Network },
  { to: "runs", label: "Runs", icon: History },
  { to: "artifacts", label: "Changes and artifacts", icon: FolderOpen },
];

export function DesktopLayout({
  children,
  header,
}: {
  children: React.ReactNode;
  header: React.ReactNode;
}) {
  const w = useWorkspaceId();
  const location = useLocation();
  const { data: projects } = useWorkspaces();
  const target = w || projects?.find((project) => project.exists)?.id;
  const { theme, toggleTheme } = useApp();
  const folder = useOpenFolder();
  const [sidebar, setSidebar] = React.useState(() => window.innerWidth >= 768);
  const [mobile, setMobile] = React.useState(() => window.innerWidth < 768);
  const sidebarRef = React.useRef<HTMLElement>(null);
  const toggleRef = React.useRef<HTMLButtonElement>(null);
  const closeSidebar = React.useCallback(() => {
    setSidebar(false);
    toggleRef.current?.focus();
  }, []);
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

  return (
    <div className="desktop-layout">
      <nav className="activity-rail" aria-label="Main">
        <Tip content="All projects" side="right">
          <Link
            to="/"
            aria-label="All projects"
            className={cn("rail-item", !w && "is-active")}
          >
            <Home />
          </Link>
        </Tip>
        <div className="rail-divider" />
        {VIEWS.map(({ to, label, icon: Icon }) => (
          <Tip key={to} content={label} side="right">
            {target ? (
              <Link
                to={target ? `/w/${target}/${to}` : "/"}
                aria-label={label}
                className={cn(
                  "rail-item",
                  w && location.pathname.split("/")[3] === to && "is-active",
                )}
              >
                <Icon />
              </Link>
            ) : (
              <button
                className="rail-item"
                aria-label={label}
                onClick={folder.open}
              >
                <Icon />
              </button>
            )}
          </Tip>
        ))}
        <div className="flex-1" />
        <Tip content="Guide" side="right">
          <Link
            to={w ? `/w/${w}/guide` : "/guide"}
            aria-label="Guide"
            className="rail-item"
          >
            <BookOpen />
          </Link>
        </Tip>
        {
          <Tip content="Settings" side="right">
            <Link
              to={w ? `/w/${w}/settings` : "/settings"}
              aria-label="Settings"
              className={cn(
                "rail-item",
                location.pathname.endsWith("/settings") && "is-active",
              )}
            >
              <Settings />
            </Link>
          </Tip>
        }
        <Tip
          content={theme === "dark" ? "Light theme" : "Dark theme"}
          side="right"
        >
          <button
            className="rail-item"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
        </Tip>
        <Link to="/" aria-label="Octopus home" className="rail-brand">
          <img src="/octopus.svg" alt="" />
        </Link>
      </nav>
      <div className="desktop-surface">
        {sidebar && mobile && (
          <button
            className="sidebar-backdrop"
            tabIndex={-1}
            aria-label="Close project sidebar"
            onClick={closeSidebar}
          />
        )}
        {sidebar && (
          <ProjectSidebar
            mobile={mobile}
            onClose={closeSidebar}
            panelRef={sidebarRef}
          />
        )}
        <div className="desktop-main">
          <header className="desktop-header">
            <Button
              ref={toggleRef}
              variant="ghost"
              size="icon"
              aria-label={
                sidebar ? "Hide project sidebar" : "Show project sidebar"
              }
              aria-expanded={sidebar}
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
            </Button>
            {header}
          </header>
          <main
            id="main-content"
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {children}
          </main>
        </div>
      </div>
      {folder.element}
    </div>
  );
}

function ProjectSidebar({
  mobile,
  onClose,
  panelRef,
}: {
  mobile: boolean;
  onClose: () => void;
  panelRef: React.Ref<HTMLElement>;
}) {
  const w = useWorkspaceId();
  const location = useLocation();
  const navigate = useNavigate();
  const projects = useWorkspaces();
  const { companyId, setCompanyId } = useCompanyId();
  const companies = useCompanies(w);
  const runs = useRuns(w, companyId || undefined, true);
  const store = useWorkbenchStore();
  const key = threadKey(w, companyId);
  const selected = store.threads[key];
  const activeRun = selected === undefined ? runs.data?.[0]?.id : selected;
  const folder = useOpenFolder();
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(false);
  const filtered = [...(projects.data ?? [])]
    .sort((a, b) =>
      String(b.last_opened_at ?? "").localeCompare(
        String(a.last_opened_at ?? ""),
      ),
    )
    .filter((p) =>
      `${p.name} ${p.display_path || p.path}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
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
      className="project-sidebar"
      aria-label="Projects and conversations"
    >
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
          aria-label="Search projects"
          aria-expanded={searching}
          onClick={() => setSearching(!searching)}
        >
          <Search />
        </Button>
        {mobile && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close sidebar"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </div>
      <button className="sidebar-new-chat" onClick={newChat}>
        <SquarePen className="h-4 w-4" />
        <span>New conversation</span>
        <Plus className="ml-auto h-3.5 w-3.5 opacity-40" />
      </button>
      {searching && (
        <div className="px-4 pb-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter projects"
            placeholder="Find a project…"
            className="sidebar-search"
          />
        </div>
      )}
      <div className="sidebar-scroll">
        <div className="sidebar-section-heading">
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            className="flex items-center gap-1.5"
          >
            {collapsed ? <ChevronRight /> : <ChevronDown />}Projects
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open project folder"
            onClick={folder.open}
            loading={folder.busy}
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
              <div key={project.id}>
                <Link
                  to={project.exists ? `/w/${project.id}/agent` : "/"}
                  aria-disabled={!project.exists}
                  onClick={(e) => {
                    if (!project.exists) e.preventDefault();
                  }}
                  className={cn(
                    "sidebar-project",
                    w === project.id && "is-selected",
                    !project.exists && "opacity-40",
                  )}
                  title={project.display_path || project.path}
                >
                  {w === project.id ? <FolderOpen /> : <Folder />}
                  <span>{project.name}</span>
                  {w === project.id && (
                    <ChevronDown className="!h-3 !w-3 opacity-50" />
                  )}
                </Link>
                {w === project.id && (
                  <div className="sidebar-conversations">
                    {selected === null &&
                      location.pathname.endsWith("/agent") && (
                        <button
                          className="sidebar-conversation is-selected"
                          onClick={newChat}
                        >
                          <span>New conversation</span>
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        </button>
                      )}
                    {runs.data?.slice(0, 12).map((run) => (
                      <button
                        key={run.id}
                        className={cn(
                          "sidebar-conversation",
                          activeRun === run.id &&
                            location.pathname.endsWith("/agent") &&
                            "is-selected",
                        )}
                        title={run.goal.split("\n")[0]}
                        onClick={() => {
                          store.selectThread(key, run.id);
                          navigate(`/w/${w}/agent`);
                        }}
                      >
                        <span>{run.goal.split("\n")[0]}</span>
                        {["running", "queued", "awaiting_user"].includes(
                          run.status,
                        ) && (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                      </button>
                    ))}
                    {runs.isError ? (
                      <button
                        className="px-3 py-2 text-xs text-muted-foreground"
                        onClick={() => void runs.refetch()}
                      >
                        Retry conversations
                      </button>
                    ) : (
                      !runs.isLoading &&
                      !runs.data?.length && (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          Your conversations will appear here.
                        </p>
                      )
                    )}
                    {!!runs.data?.length && (
                      <Link className="sidebar-history" to={`/w/${w}/runs`}>
                        View all activity
                        <ArrowUpRight />
                      </Link>
                    )}
                  </div>
                )}
              </div>
            ))}
            {!projects.isLoading && !projects.isError && !filtered.length && (
              <p className="px-5 py-3 text-xs text-muted-foreground">
                {query
                  ? "No matching projects."
                  : "Open a folder to get started."}
              </p>
            )}
          </div>
        )}
        {w && !!companies.data?.length && (
          <div className="sidebar-team">
            <span className="sidebar-section-label">Current team</span>
            <select
              aria-label="Select project team"
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              className="mx-2 mb-2 w-[calc(100%-1rem)] rounded-lg border bg-surface px-2 py-2 text-xs"
            >
              {companies.data.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
            <Link to={`/w/${w}/canvas`}>
              <Network className="h-4 w-4" />
              <span>Manage your team</span>
              <ArrowUpRight className="h-3 w-3" />
            </Link>
            <Link to={`/w/${w}/chat`}>
              <MessageSquare className="h-4 w-4" />
              <span>Talk to an agent</span>
            </Link>
          </div>
        )}
      </div>
      <button className="sidebar-open-folder" onClick={folder.open}>
        <FolderOpen className="h-4 w-4" />
        <span>Open project folder</span>
        <Plus className="ml-auto h-3.5 w-3.5" />
      </button>
      <div className="sidebar-footer">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        <span>Running locally</span>
        <span className="ml-auto font-mono text-[10px]">OCTOPUS</span>
      </div>
      {folder.element}
    </aside>
  );
}
