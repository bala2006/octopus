import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  Braces,
  ChevronRight,
  Diamond,
  Download,
  File as FileIcon,
  FileCode2,
  FileText,
  Hash,
  Image as ImageIcon,
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { Input } from "@/components/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { folderTones, NO_CHANGES, type Tone } from "./gitMarks";

/** A file or folder row. The path is the project-relative path. */
export type Entry = { path: string; name: string; kind: "file" | "folder" };
/** The entries directly inside one folder. The root's path is "". */
export type Listing = { files: string[]; folders: string[] };

type ExplorerProps = {
  workspace: string;
  /** Git changes keyed by project path. Folders are derived from these. */
  changes?: ReadonlyMap<string, Tone>;
  selected: string | null;
  onOpen: (path: string) => void;
  onAction?: (kind: "move" | "trash", path: string) => void;
  onDownload?: (path: string) => void;
};
type RowProps = Pick<ExplorerProps, "selected" | "onOpen" | "onAction" | "onDownload"> & {
  node: Entry;
  depth: number;
  tone?: Tone;
  expanded?: boolean;
  onToggle?: (path: string) => void;
};

/** One visible row. Rows are a fixed height, so the list can place them by index. */
const ROW_H = 22;
/** Rows drawn above and below the viewport, so a fast scroll does not show blank space. */
const OVERSCAN = 12;
const REFRESH_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;

type Item = { node: Entry; depth: number; expanded: boolean };

const TONE_TEXT: Record<Tone, string> = {
  untracked: "text-success",
  added: "text-success",
  modified: "text-warning",
  deleted: "text-destructive",
};
const TONE_LETTER: Record<Tone, string> = {
  untracked: "U",
  added: "A",
  modified: "M",
  deleted: "D",
};
const TONE_LABEL: Record<Tone, string> = {
  untracked: "Not yet tracked by Git",
  added: "Added to Git",
  modified: "Modified",
  deleted: "Deleted",
};

type FileStyle = { Icon: LucideIcon; className: string };
const PLAIN_FILE: FileStyle = { Icon: FileIcon, className: "text-muted-foreground" };
const BY_EXTENSION = new Map<string, FileStyle>([
  ["json", { Icon: Braces, className: "text-yellow-400" }],
  ["js", { Icon: FileCode2, className: "text-yellow-400" }],
  ["mjs", { Icon: FileCode2, className: "text-yellow-400" }],
  ["cjs", { Icon: FileCode2, className: "text-yellow-400" }],
  ["jsx", { Icon: FileCode2, className: "text-yellow-400" }],
  ["ts", { Icon: FileCode2, className: "text-sky-400" }],
  ["tsx", { Icon: FileCode2, className: "text-sky-400" }],
  ["html", { Icon: FileCode2, className: "text-orange-400" }],
  ["css", { Icon: Hash, className: "text-sky-400" }],
  ["scss", { Icon: Hash, className: "text-pink-400" }],
  ["md", { Icon: FileText, className: "text-sky-300" }],
  ["png", { Icon: ImageIcon, className: "text-purple-400" }],
  ["jpg", { Icon: ImageIcon, className: "text-purple-400" }],
  ["jpeg", { Icon: ImageIcon, className: "text-purple-400" }],
  ["gif", { Icon: ImageIcon, className: "text-purple-400" }],
  ["webp", { Icon: ImageIcon, className: "text-purple-400" }],
  ["svg", { Icon: ImageIcon, className: "text-purple-400" }],
  ["ico", { Icon: ImageIcon, className: "text-purple-400" }],
]);

/** Picks a file-type icon the way VS Code's explorer does, from the file name. */
function fileStyle(name: string): FileStyle {
  if (name === ".env" || name.startsWith(".env.")) {
    return { Icon: Settings, className: "text-muted-foreground" };
  }
  if (name === ".gitignore" || name === ".gitattributes") {
    return { Icon: Diamond, className: "text-muted-foreground" };
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return PLAIN_FILE;
  return BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? PLAIN_FILE;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Loads the entries of one folder. The server lists only that folder, so a large project never loads at once. */
export function listFolder(workspace: string, path: string): Promise<Listing> {
  return unwrap(
    api.GET("/api/v1/w/{workspace_id}/editor/tree", {
      params: { path: { workspace_id: workspace }, query: { path } },
    }),
  );
}

/**
 * The rows the tree shows, in order. Folders come first, as in the listings. A folder's children are listed only
 * while the folder is expanded and its listing has loaded.
 */
export function flattenTree(listingOf: (path: string) => Listing | undefined, expanded: ReadonlySet<string>): Item[] {
  const items: Item[] = [];
  const walk = (dir: string, depth: number) => {
    const listing = listingOf(dir);
    if (!listing) return;
    const entries: Entry[] = [
      ...listing.folders.map((path) => ({ path, name: nameOf(path), kind: "folder" as const })),
      ...listing.files.map((path) => ({ path, name: nameOf(path), kind: "file" as const })),
    ];
    for (const entry of entries) {
      const open = entry.kind === "folder" && expanded.has(entry.path);
      items.push({ node: entry, depth, expanded: open });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return items;
}

export type ExplorerHandle = { collapseAll: () => void };

/**
 * The project tree. Folders start collapsed, and each one loads only when it opens. Only the rows inside the viewport
 * are mounted, so a project with thousands of files stays fast. Rows have a fixed height, which lets each one be placed
 * by its index.
 */
export const Explorer = React.memo(
  React.forwardRef<ExplorerHandle, ExplorerProps>(function Explorer(props, ref) {
    const { workspace, selected, changes = NO_CHANGES } = props;
    const [filter, setFilter] = React.useState("");
    const [query, setQuery] = React.useState("");
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
    const [view, setView] = React.useState({ top: 0, height: 0 });
    const list = React.useRef<HTMLElement>(null);
    const folderChanges = React.useMemo(() => folderTones(changes), [changes]);

    React.useEffect(() => {
      const timer = setTimeout(() => setQuery(filter.trim()), SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [filter]);

    const root = useQuery({
      queryKey: ["editor-tree", workspace, ""],
      queryFn: () => listFolder(workspace, ""),
      refetchInterval: REFRESH_MS,
    });
    const expandedPaths = [...expanded];
    const folders = useQueries({
      queries: expandedPaths.map((path) => ({
        queryKey: ["editor-tree", workspace, path],
        queryFn: () => listFolder(workspace, path),
        refetchInterval: REFRESH_MS,
      })),
    });
    const matches = useQuery({
      queryKey: ["editor-files", workspace, query],
      queryFn: () =>
        unwrap(
          api.GET("/api/v1/w/{workspace_id}/editor/files", {
            params: { path: { workspace_id: workspace }, query: { q: query } },
          }),
        ),
      enabled: query.length > 0,
    });

    // Rebuild the rows only when a listing or the search result changes, not on every scroll.
    const version = [root.dataUpdatedAt, matches.dataUpdatedAt, ...folders.map((f) => f.dataUpdatedAt)].join(",");
    const items = React.useMemo<Item[]>(() => {
      if (filter.trim()) {
        return (matches.data?.files ?? []).map((path) => ({
          node: { path, name: path, kind: "file" as const },
          depth: 0,
          expanded: false,
        }));
      }
      const listings = new Map<string, Listing>();
      if (root.data) listings.set("", root.data);
      expandedPaths.forEach((path, i) => {
        const data = folders[i]?.data;
        if (data) listings.set(path, data);
      });
      return flattenTree((path) => listings.get(path), expanded);
    }, [version, filter, expanded]);

    React.useImperativeHandle(ref, () => ({ collapseAll: () => setExpanded(new Set()) }), []);
    // An open file's folders expand, so the file is visible in the tree.
    React.useEffect(() => {
      if (!selected) return;
      const parts = selected.split("/");
      const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      setExpanded((previous) => new Set([...previous, ...ancestors]));
    }, [selected]);
    const toggle = (path: string) =>
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });

    const measure = React.useCallback(() => {
      const el = list.current;
      if (!el) return;
      setView((v) =>
        v.top === el.scrollTop && v.height === el.clientHeight
          ? v
          : { top: el.scrollTop, height: el.clientHeight },
      );
    }, []);
    React.useEffect(() => {
      const el = list.current;
      if (!el) return;
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }, [measure]);

    const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN);
    const last = Math.min(items.length, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN);
    const searching = filter.trim().length > 0;
    const empty = root.isSuccess && !root.data.files.length && !root.data.folders.length;

    return (
      <>
        <div className="relative m-2">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            aria-label="Find a file"
            placeholder="Find a file…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-9 pl-8 text-xs"
          />
        </div>
        <nav
          ref={list}
          aria-label="Project files"
          onScroll={measure}
          className="min-h-0 flex-1 overflow-auto pb-3"
        >
          {root.isLoading && (
            <p role="status" className="p-3 text-xs text-muted-foreground">
              Loading project files.
            </p>
          )}
          {root.isError && (
            <p role="alert" className="p-3 text-xs text-destructive">
              {root.error.message}
            </p>
          )}
          <div className="relative" style={{ height: items.length * ROW_H }}>
            {items.slice(first, last).map((item, i) => (
              <div
                key={item.node.path}
                className="absolute inset-x-0"
                style={{ top: (first + i) * ROW_H }}
              >
                <Row
                  node={item.node}
                  depth={item.depth}
                  selected={selected}
                  onOpen={props.onOpen}
                  onAction={props.onAction}
                  onDownload={props.onDownload}
                  tone={
                    item.node.kind === "folder"
                      ? folderChanges.get(item.node.path)
                      : changes.get(item.node.path)
                  }
                  expanded={item.expanded}
                  onToggle={toggle}
                />
              </div>
            ))}
          </div>
          {searching && matches.isFetching && !matches.data && (
            <p className="p-4 text-xs text-muted-foreground">Searching…</p>
          )}
          {searching && matches.data && !items.length && !matches.isFetching && (
            <p className="p-4 text-xs text-muted-foreground">
              No files match “{filter.trim()}”.
            </p>
          )}
          {searching && matches.data?.truncated && (
            <p className="p-4 text-xs text-muted-foreground">
              Showing the first matches. Type more of the name to narrow the list.
            </p>
          )}
          {empty && (
            <p className="p-4 text-xs leading-relaxed text-muted-foreground">
              Your project is empty. Create a file, upload an asset, or ask your
              team to build something.
            </p>
          )}
        </nav>
      </>
    );
  }),
);

function Row({
  node,
  depth,
  tone,
  selected,
  onOpen,
  onAction,
  onDownload,
  expanded,
  onToggle,
}: RowProps) {
  const folder = node.kind === "folder";
  const { Icon, className: iconClass } = fileStyle(node.name);
  return (
    <div
      className={cn(
        "group flex h-[22px] items-center transition-colors hover:bg-accent",
        selected === node.path && "bg-accent text-foreground",
      )}
    >
      <button
        title={node.path}
        aria-label={
          folder
            ? `${expanded ? "Collapse" : "Expand"} ${node.path}`
            : undefined
        }
        aria-expanded={folder ? expanded : undefined}
        aria-current={selected === node.path ? "page" : undefined}
        aria-description={tone ? TONE_LABEL[tone] : undefined}
        onClick={() => (folder ? onToggle?.(node.path) : onOpen(node.path))}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 text-left text-[13px] leading-none",
          tone && TONE_TEXT[tone],
        )}
        style={{ paddingLeft: 8 + depth * 10 }}
      >
        {folder ? (
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClass)} />
        )}
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {tone && folder && (
          <span
            aria-hidden="true"
            className="mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current"
          />
        )}
        {tone && !folder && (
          <span aria-hidden="true" className="mr-1 shrink-0 text-[11px] font-semibold">
            {TONE_LETTER[tone]}
          </span>
        )}
      </button>
      {onAction && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Actions for ${node.path}`}
              className="mr-1 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-background group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction("move", node.path)}>
              <Pencil />
              Rename or move {node.kind}
            </DropdownMenuItem>
            {!folder && onDownload && (
              <DropdownMenuItem onSelect={() => onDownload(node.path)}>
                <Download />
                Download file
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              destructive
              onSelect={() => onAction("trash", node.path)}
            >
              <Trash2 />
              Delete {node.kind}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
