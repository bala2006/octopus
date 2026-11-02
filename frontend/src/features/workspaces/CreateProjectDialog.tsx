import * as React from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Laptop,
  Loader2,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { api, unwrap } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";

export type ProjectFolder = { path: string; displayPath: string };

function folderName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onChooseFolder,
  onCreateProject,
  initialPath,
  choosingFolder = false,
  creatingProject = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChooseFolder: () => Promise<ProjectFolder | null>;
  onCreateProject: (folder: ProjectFolder, name: string) => Promise<void>;
  initialPath?: string;
  choosingFolder?: boolean;
  creatingProject?: boolean;
}) {
  const [name, setName] = React.useState("");
  const [folder, setFolder] = React.useState<ProjectFolder | null>(null);
  const [folderMenuOpen, setFolderMenuOpen] = React.useState(false);
  const [browserOpen, setBrowserOpen] = React.useState(false);
  const [manualPathOpen, setManualPathOpen] = React.useState(false);
  const [manualPath, setManualPath] = React.useState("");
  const [browsePath, setBrowsePath] = React.useState<string | undefined>(initialPath);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const browse = useQuery({
    queryKey: ["create-project-browse", browsePath ?? ""],
    enabled: open && browserOpen,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/fs/browse", {
          params: { query: browsePath ? { path: browsePath } : {} },
        }),
      ),
  });

  React.useEffect(() => {
    if (open) {
      setName("");
      setFolder(null);
      setFolderMenuOpen(false);
      setBrowserOpen(false);
      setManualPathOpen(false);
      setManualPath("");
      setError("");
      setNotice("");
      setBrowsePath(initialPath);
    }
  }, [open, initialPath]);

  const chooseFolder = async () => {
    setError("");
    setNotice("");
    try {
      const selected = await onChooseFolder();
      if (selected) {
        setFolder(selected);
        setManualPathOpen(false);
      }
    } catch {
      setNotice("Windows folder picker is unavailable. Start Octopus with start.bat to open the native picker, or browse folders here.");
      setBrowserOpen(true);
      setBrowsePath(initialPath);
    }
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!folder || creatingProject) return;
    setError("");
    try {
      // Keep the name field empty by default; the folder name is the create-time fallback.
      await onCreateProject(folder, name.trim() || folderName(folder.path));
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The project could not be created.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="create-project-dialog max-w-[650px] gap-0 p-0">
        <DialogHeader className="create-project-header">
          <DialogTitle className="flex items-center gap-2 text-[20px]">
            <FolderOpen className="h-[18px] w-[18px] text-primary" />
            Create project
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={createProject} className="create-project-body">
          <label className="create-project-name">
            <span className="sr-only">Project name</span>
            <Folder className="create-project-name-icon" aria-hidden="true" />
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Project name"
              aria-label="Project name"
              maxLength={200}
              className="create-project-name-input"
            />
          </label>

          <section className="create-project-sources" aria-labelledby="source-folders-label">
            <h3 id="source-folders-label" className="text-sm font-semibold">Source folders</h3>
            <div className={`create-project-source-card${browserOpen && !folder ? " is-browsing" : ""}`}>
              {folder ? (
                <div className="create-project-folder-row">
                  <FolderOpen className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{folderName(folder.displayPath || folder.path)}</span>
                    <span className="block truncate text-xs text-muted-foreground" title={folder.displayPath}>
                      {folder.displayPath}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove source folder"
                    onClick={() => setFolder(null)}
                  >
                    <X />
                  </Button>
                  <Button type="button" size="xs" variant="outline" onClick={() => void chooseFolder()} loading={choosingFolder}>
                    Change
                  </Button>
                </div>
              ) : !browserOpen ? (
                <>
                  <Popover open={folderMenuOpen} onOpenChange={setFolderMenuOpen}>
                    <PopoverTrigger asChild>
                      <button type="button" className="create-project-source-location" aria-label="Choose folder source">
                        <span>Add a folder on <strong>this computer</strong></span>
                        <ChevronDown />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="center" className="create-project-source-menu">
                      <button
                        type="button"
                        className="create-project-computer-option"
                        onClick={() => {
                          setFolderMenuOpen(false);
                          void chooseFolder();
                        }}
                      >
                        <Laptop />
                        <span><strong>This computer</strong><small>Browse local folders</small></span>
                        <Check />
                      </button>
                    </PopoverContent>
                  </Popover>
                  <Button type="button" size="sm" variant="secondary" className="rounded-full" onClick={() => void chooseFolder()} loading={choosingFolder}>
                    <FolderPlus />
                    Add
                  </Button>
                </>
              ) : null}

              {browserOpen && !folder && (
                <div className="create-project-browser">
                  <div className="create-project-browser-head">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Go up one folder"
                      disabled={!browse.data?.parent}
                      onClick={() => setBrowsePath(browse.data?.parent ?? undefined)}
                    >
                      <ArrowUp />
                    </Button>
                    <span className="min-w-0 flex-1 truncate" title={browse.data?.display_path || "This computer"}>
                      {browse.data?.display_path || "This computer"}
                    </span>
                    {browse.data?.path && (
                      <Button
                        type="button"
                        size="xs"
                        onClick={() => {
                          const selectedPath = browse.data?.display_path || browse.data?.path;
                          if (selectedPath) {
                            setFolder({ path: selectedPath, displayPath: selectedPath });
                            setBrowserOpen(false);
                            setManualPathOpen(false);
                            setError("");
                          }
                        }}
                      >
                        Use this folder
                      </Button>
                    )}
                  </div>
                  <div className="create-project-browser-list" aria-label="Local folders" role="list">
                    {browse.isLoading && <div className="create-project-browser-state"><Loader2 className="animate-spin" />Loading folders…</div>}
                    {browse.isError && (
                      <div className="create-project-browser-state is-error" role="alert">
                        {browse.error.message}
                        <Button type="button" variant="ghost" size="xs" onClick={() => void browse.refetch()}>Retry</Button>
                      </div>
                    )}
                    {!browse.isLoading && !browse.isError && browse.data?.entries.map((entry) => {
                      const Icon = entry.is_git ? FolderGit2 : Folder;
                      const label = entry.name === "host" ? "Laptop folders" : entry.name === "workspaces" ? "Octopus projects" : entry.name;
                      return (
                        <div role="listitem" key={entry.path}>
                          <button
                            type="button"
                            className="create-project-browser-entry"
                            onClick={() => setBrowsePath(entry.path)}
                          >
                            <Icon />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{label}</span>
                              <small className="block truncate">{entry.display_path || entry.path}</small>
                            </span>
                            {entry.is_project && <span className="create-project-browser-tag">Project</span>}
                            <ChevronRight />
                          </button>
                        </div>
                      );
                    })}
                    {!browse.isLoading && !browse.isError && !browse.data?.entries.length && (
                      <p className="create-project-browser-state">No folders here.</p>
                    )}
                  </div>
                  <button type="button" className="create-project-path-toggle" onClick={() => setManualPathOpen((value) => !value)}>
                    {manualPathOpen ? "Browse folders instead" : "Enter a folder path instead"}
                  </button>
                </div>
              )}
            </div>

            {notice && <p className="create-project-notice" role="status">{notice}</p>}
            {manualPathOpen && browserOpen && !folder && (
              <div className="create-project-manual-path">
                <label htmlFor="project-source-path">Paste a local folder path</label>
                <div className="flex gap-2">
                  <Input
                    id="project-source-path"
                    autoFocus
                    value={manualPath}
                    onChange={(event) => setManualPath(event.target.value)}
                    placeholder="C:\\Users\\you\\Projects\\app"
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!manualPath.trim()}
                    onClick={() => {
                      const path = manualPath.trim();
                      if (!path) return;
                      setFolder({ path, displayPath: path });
                      setError("");
                    }}
                  >Use folder</Button>
                </div>
              </div>
            )}
            {error && <p className="create-project-error" role="alert">{error}</p>}
          </section>

          <footer className="create-project-footer">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!folder || creatingProject} loading={creatingProject}>
              Create project
            </Button>
          </footer>
        </form>
      </DialogContent>
    </Dialog>
  );
}
