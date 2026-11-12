/**
 * The window bar: history navigation, the sidebar toggle and the File / View / Help menus. Every entry does something;
 * entries that need an open project are disabled with a hint until one is open. Settings, your profile and the theme
 * live in the profile menu on the rail, so they are not repeated here.
 */
import * as React from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { ArrowLeft, ArrowRight, BookOpen, Bug, Download, FileSearch, FolderOpen, Home, Info, Keyboard, PanelLeft, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@/hooks/queries";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { download } from "@/lib/utils";
import { fetchRaw } from "@/lib/api";
import { QUICK_OPEN_EVENT } from "./CommandPalette";
import { SPACES } from "./spaces";

let furthest = 0;

export function AppMenuBar({ onToggleSidebar, onNewConversation, onOpenFolder }: {
  onToggleSidebar: () => void;
  onNewConversation: () => void;
  onOpenFolder: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const w = useWorkspaceId();
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  React.useEffect(() => { if (navType === "PUSH" || idx > furthest) furthest = idx; }, [location.key, navType, idx]);
  const inProject = (to: string) => (w ? () => navigate(`/w/${w}/${to}`) : undefined);
  const needsProject = !w;
  const projectHint = needsProject ? "Open a project first" : undefined;
  const downloadFiles = async () => {
    const t = toast.loading("Preparing ZIP…");
    try {
      const res = await fetchRaw(`/api/v1/w/${w}/files.zip`);
      download("project.zip", await res.blob(), "application/zip");
      toast.success("Downloaded the project files", { id: t });
    } catch (e) {
      toast.error("Download failed", { id: t, description: (e as Error).message });
    }
  };
  const item = (label: string, icon: React.ReactNode, onSelect?: () => void, shortcut?: string, hint?: string) => (
    <DropdownMenuItem disabled={!onSelect} onSelect={onSelect} title={!onSelect ? hint : undefined}>
      {icon}{label}{shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
  const menu = (label: string, children: React.ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className="app-top-menu">{label}</button></DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <div className="app-top-rail" role="toolbar" aria-label="Application menu">
      <div className="app-top-navigation">
        <button type="button" aria-label="Back" title="Back" disabled={idx <= 0} onClick={() => navigate(-1)}><ArrowLeft /></button>
        <button type="button" aria-label="Forward" title="Forward" disabled={idx >= furthest} onClick={() => navigate(1)}><ArrowRight /></button>
        <button type="button" aria-label="Toggle sidebar" title="Show or hide projects and conversations" onClick={onToggleSidebar}><PanelLeft /></button>
      </div>
      {menu("File", <>
        {item("New conversation", <SquarePen />, onNewConversation)}
        {item("Open project folder…", <FolderOpen />, onOpenFolder)}
        <DropdownMenuSeparator />
        {item("Download project files", <Download />, w ? () => void downloadFiles() : undefined, undefined, projectHint)}
        {item("Home", <Home />, () => navigate("/"))}
      </>)}
      {menu("View", <>
        <DropdownMenuLabel>{needsProject ? "Open a project to see its spaces" : "Spaces"}</DropdownMenuLabel>
        {SPACES.map((v) => <React.Fragment key={v.to}>{item(v.label, <v.icon />, inProject(v.to), `Alt ${v.key}`, projectHint)}</React.Fragment>)}
        <DropdownMenuSeparator />
        {item("Quick open…", <FileSearch />, w ? () => window.dispatchEvent(new Event(QUICK_OPEN_EVENT)) : undefined, "Ctrl K", projectHint)}
        {item("Toggle sidebar", <PanelLeft />, onToggleSidebar)}
      </>)}
      {menu("Help", <>
        {item("Guide", <BookOpen />, () => navigate(w ? `/w/${w}/guide` : "/guide"))}
        {item("Keyboard shortcuts", <Keyboard />, () => navigate(`${w ? `/w/${w}/guide` : "/guide"}#shortcuts`))}
        <DropdownMenuSeparator />
        {item("Report an issue", <Bug />, () => window.open("https://github.com/bala2006/octopus/issues/new/choose", "_blank", "noopener"))}
        {item("About Octopus", <Info />, () => window.open("https://github.com/bala2006/octopus#readme", "_blank", "noopener"))}
      </>)}
    </div>
  );
}
