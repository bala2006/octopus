import * as React from "react";
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
import { Input } from "@/components/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { folderTones, NO_CHANGES, type Tone } from "./gitMarks";

type Node = {
  path: string;
  name: string;
  kind: "file" | "folder";
  children: Map<string, Node>;
};
type ExplorerProps = {
  files: string[];
  folders: string[];
  /** Git changes keyed by project path. Folders are derived from these. */
  changes?: ReadonlyMap<string, Tone>;
  selected: string | null;
  onOpen: (path: string) => void;
  onAction?: (kind: "move" | "trash", path: string) => void;
  onDownload?: (path: string) => void;
};

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

function folderPaths(node: Node): string[] {
  return [...node.children.values()].flatMap((child) =>
    child.kind === "folder" ? [child.path, ...folderPaths(child)] : [],
  );
}

export type ExplorerHandle = { collapseAll: () => void };

export const Explorer = React.memo(
  React.forwardRef<ExplorerHandle, ExplorerProps>(function Explorer(props, ref) {
  const { files, folders, selected, changes = NO_CHANGES } = props;
  const [filter, setFilter] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const root = React.useMemo(
    () => buildExplorer(files, folders),
    [files, folders],
  );
  const folderChanges = React.useMemo(() => folderTones(changes), [changes]);
  React.useImperativeHandle(
    ref,
    () => ({ collapseAll: () => setCollapsed(new Set(folderPaths(root))) }),
    [root],
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
            tone={
              child.kind === "folder"
                ? folderChanges.get(child.path)
                : changes.get(child.path)
            }
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
        className="min-h-0 flex-1 overflow-auto pb-3"
      >
        {filter
          ? matches.map((path) => (
              <Row
                key={path}
                node={{ path, name: path, kind: "file", children: new Map() }}
                depth={0}
                {...props}
                tone={changes.get(path)}
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
}: ExplorerProps & {
  node: Node;
  depth: number;
  tone?: Tone;
  expanded?: boolean;
  onToggle?: (path: string) => void;
}) {
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
