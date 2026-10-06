import * as React from "react";
import {
  ChevronRight,
  Download,
  FileCode2,
  Folder,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

type Node = {
  path: string;
  name: string;
  kind: "file" | "folder";
  children: Map<string, Node>;
};
type ExplorerProps = {
  files: string[];
  folders: string[];
  selected: string | null;
  onOpen: (path: string) => void;
  onAction?: (kind: "move" | "trash", path: string) => void;
  onDownload?: (path: string) => void;
};

export function buildExplorer(files: string[], folders: string[]): Node {
  const root: Node = {
    path: "",
    name: "",
    kind: "folder",
    children: new Map(),
  };
  for (const [paths, kind] of [
    [folders, "folder"],
    [files, "file"],
  ] as const) {
    for (const path of paths) {
      const parts = path.split("/");
      let parent = root;
      parts.forEach((name, index) => {
        let node = parent.children.get(name);
        if (!node) {
          node = {
            name,
            path: parts.slice(0, index + 1).join("/"),
            kind: index === parts.length - 1 ? kind : "folder",
            children: new Map(),
          };
          parent.children.set(name, node);
        }
        parent = node;
      });
    }
  }
  return root;
}

export const Explorer = React.memo(function Explorer(props: ExplorerProps) {
  const { files, folders, selected } = props;
  const [filter, setFilter] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const root = React.useMemo(
    () => buildExplorer(files, folders),
    [files, folders],
  );
  React.useEffect(() => {
    if (selected)
      setCollapsed(
        (previous) =>
          new Set([...previous].filter((p) => !selected.startsWith(`${p}/`))),
      );
  }, [selected]);
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (node: Node, depth: number): React.ReactNode =>
    [...node.children.values()]
      .sort(
        (a, b) =>
          (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
          a.name.localeCompare(b.name),
      )
      .map((child) => (
        <React.Fragment key={child.path}>
          <Row
            node={child}
            depth={depth}
            {...props}
            expanded={!collapsed.has(child.path)}
            onToggle={toggle}
          />
          {child.kind === "folder" &&
            !collapsed.has(child.path) &&
            render(child, depth + 1)}
        </React.Fragment>
      ));
  const matches = files.filter((p) =>
    p.toLowerCase().includes(filter.toLowerCase()),
  );
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
        aria-label="Project files"
        className="min-h-0 flex-1 overflow-auto px-2 pb-3"
      >
        {filter
          ? matches.map((path) => (
              <Row
                key={path}
                node={{ path, name: path, kind: "file", children: new Map() }}
                depth={0}
                {...props}
              />
            ))
          : render(root, 0)}
        {filter && !matches.length && (
          <p className="p-4 text-xs text-muted-foreground">
            No files match “{filter}”.
          </p>
        )}
        {!files.length && !folders.length && (
          <p className="p-4 text-xs leading-relaxed text-muted-foreground">
            Your project is empty. Create a file, upload an asset, or ask your
            team to build something.
          </p>
        )}
      </nav>
    </>
  );
});

function Row({
  node,
  depth,
  selected,
  onOpen,
  onAction,
  onDownload,
  expanded,
  onToggle,
}: ExplorerProps & {
  node: Node;
  depth: number;
  expanded?: boolean;
  onToggle?: (path: string) => void;
}) {
  const folder = node.kind === "folder";
  return (
    <div
      className={cn(
        "group flex items-center rounded-md transition-colors hover:bg-accent",
        selected === node.path && "bg-primary/10 text-primary",
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
        onClick={() => (folder ? onToggle?.(node.path) : onOpen(node.path))}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-1 text-left text-xs"
        style={{ paddingLeft: depth * 12 + (folder ? 4 : 19) }}
      >
        {folder && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
        )}
        {folder ? (
          <Folder className="h-4 w-4 shrink-0 text-steel" />
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {onAction && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Actions for ${node.path}`}
              className="mr-1 rounded p-1 text-muted-foreground transition hover:bg-background focus-visible:ring-2 focus-visible:ring-ring"
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
