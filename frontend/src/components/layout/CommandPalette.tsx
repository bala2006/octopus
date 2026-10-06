import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileCode2, Search } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { useWorkspaceId } from "@/hooks/queries";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

const destinations = [
  {
    name: "Workspace",
    hint: "Edit files and preview your app",
    to: "workspace",
  },
  { name: "Canvas", hint: "Design your agent team", to: "canvas" },
  { name: "Chat", hint: "Talk to an agent", to: "chat" },
  { name: "Runs", hint: "Goals, progress, and approvals", to: "runs" },
  {
    name: "Artifacts",
    hint: "Review changes and file history",
    to: "artifacts",
  },
  { name: "Settings", hint: "Models, permissions, and tools", to: "settings" },
  { name: "Guide", hint: "Learn Octopus", to: "guide" },
];

export function CommandPalette() {
  const w = useWorkspaceId();
  const nav = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const list = React.useRef<HTMLDivElement>(null);
  const tree = useQuery({
    queryKey: ["editor-tree", w],
    enabled: open,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/tree", {
          params: { path: { workspace_id: w } },
        }),
      ),
  });
  const needle = query.toLowerCase().trim();
  const items = [
    ...destinations
      .filter((d) => `${d.name} ${d.hint}`.toLowerCase().includes(needle))
      .map((d) => ({
        label: d.name,
        detail: d.hint,
        to: `/w/${w}/${d.to}`,
        file: false,
      })),
    ...(tree.data?.files ?? [])
      .filter((p) => !needle || p.toLowerCase().includes(needle))
      .slice(0, 60)
      .map((p) => ({
        label: p,
        detail: "Open file",
        to: `/w/${w}/workspace?file=${encodeURIComponent(p)}`,
        file: true,
      })),
  ];
  const selected = Math.min(index, Math.max(0, items.length - 1));
  const choose = (to: string) => {
    setOpen(false);
    nav(to);
  };
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        ["k", "p"].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  React.useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);
  React.useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <>
      <button
        aria-label="Quick open"
        title="Quick open (Ctrl+K)"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-2 rounded-md border bg-surface/50 px-2 text-xs text-muted-foreground transition-colors hover:bg-accent"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden xl:inline">Go to file or page…</span>
        <kbd className="hidden text-[10px] lg:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-xl"
          hideClose
        >
          <DialogTitle className="sr-only">Quick open</DialogTitle>
          <DialogDescription className="sr-only">
            Search files or pages. Use arrow keys and Enter to open a result.
          </DialogDescription>
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Search className="h-5 w-5 shrink-0 text-primary" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              placeholder="Search files and pages…"
              className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              role="combobox"
              aria-label="Search files and pages"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls="quick-open-results"
              aria-activedescendant={
                items.length ? `quick-open-${selected}` : undefined
              }
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIndex((selected + 1) % Math.max(items.length, 1));
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIndex(
                    (selected - 1 + items.length) % Math.max(items.length, 1),
                  );
                }
                if (e.key === "Enter" && items[selected]) {
                  e.preventDefault();
                  choose(items[selected].to);
                }
              }}
            />
            <kbd className="kbd">Esc</kbd>
          </div>
          <div
            ref={list}
            role="listbox"
            id="quick-open-results"
            aria-label="Files and pages"
            className="max-h-[55vh] overflow-y-auto p-2"
          >
            {items.map((item, i) => (
              <button
                key={item.to}
                id={`quick-open-${i}`}
                data-index={i}
                role="option"
                aria-selected={selected === i}
                tabIndex={-1}
                onMouseMove={() => setIndex(i)}
                onClick={() => choose(item.to)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                  selected === i
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent",
                )}
              >
                {item.file ? (
                  <FileCode2 className="h-4 w-4 shrink-0" />
                ) : (
                  <Search className="h-4 w-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                </span>
                {selected === i && <kbd className="kbd">Enter</kbd>}
              </button>
            ))}
            {!items.length && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                No matching files or pages.
              </p>
            )}
            {tree.isError && (
              <p role="alert" className="p-3 text-xs text-destructive">
                Files could not be loaded. {tree.error.message}
              </p>
            )}
            {tree.isLoading && (
              <p className="p-3 text-xs text-muted-foreground">
                Loading files…
              </p>
            )}
          </div>
          <div className="border-t px-4 py-2 text-[11px] text-muted-foreground">
            ↑ ↓ to navigate · Enter to open · Esc to close
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
