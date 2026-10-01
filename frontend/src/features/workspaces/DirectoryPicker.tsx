import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowUp, ChevronRight, Folder, FolderGit2, FolderOpen, FolderPlus, HardDrive, Loader2, Check } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { PERMISSIONS } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { qk } from "@/hooks/queries";
import type { PermissionLevel } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/overlays";

export function PermissionPicker({ value, onChange, compact }: { value: PermissionLevel; onChange: (v: PermissionLevel) => void; compact?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Permission level" className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-2")}>
      {(Object.keys(PERMISSIONS) as PermissionLevel[]).map((k) => {
        const p = PERMISSIONS[k];
        const Icon = p.icon;
        const active = value === k;
        return (
          <button key={k} type="button" role="radio" aria-checked={active} onClick={() => onChange(k)}
            className={cn("group relative rounded-lg border p-2.5 text-left transition-all hover:border-primary/50 hover:bg-accent/40",
              active ? "border-primary bg-primary/5 shadow-sm shadow-primary/10" : "border-border")}>
            <div className="flex items-center gap-1.5 text-xs font-semibold"><Icon className={cn("h-3.5 w-3.5", p.tone)} />{compact ? p.short : p.label}
              {active && <Check className="ml-auto h-3.5 w-3.5 text-primary animate-in zoom-in-50" />}</div>
            {!compact && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{p.description}</p>}
          </button>
        );
      })}
    </div>
  );
}

/** In-app folder browser: the fallback when the OS folder dialog isn't available (Docker, SSH, remote browser). */
export function DirectoryPicker({ open, onOpenChange, notice }: { open: boolean; onOpenChange: (o: boolean) => void; notice?: string }) {
  const [path, setPath] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [perm, setPerm] = React.useState<PermissionLevel>("ask");
  const [newFolder, setNewFolder] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const nav = useNavigate();

  const browse = useQuery({
    queryKey: ["browse", path ?? ""], enabled: open, placeholderData: (p) => p,
    queryFn: () => unwrap(api.GET("/api/v1/fs/browse", { params: { query: path ? { path } : {} } })),
  });
  const current = browse.data?.path ?? null;
  const entries = browse.data?.entries ?? [];
  const target = selected ?? current;
  // In Docker the backend works on /host/…; show (and accept) the path as it is on the laptop.
  const display = (p: string | null) => !p ? "" : p === current ? (browse.data?.display_path || p) : (entries.find((e) => e.path === p)?.display_path || p);
  const [goTo, setGoTo] = React.useState("");

  React.useEffect(() => { setCursor(0); setSelected(null); }, [path]);
  React.useEffect(() => { if (target) setName(target.split(/[\\/]/).filter(Boolean).pop() ?? ""); }, [target]);

  const mkdir = useMutation({
    mutationFn: (n: string) => unwrap(api.POST("/api/v1/fs/mkdir", { body: { parent: current!, name: n } })),
    onSuccess: (d) => { setNewFolder(null); qc.invalidateQueries({ queryKey: ["browse", path ?? ""] }); setSelected(d.path); toast.success(`Created ${d.name}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/workspaces", { body: { path: target!, name: name || undefined, default_permission: perm } })),
    onSuccess: (w) => {
      qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success(w.existing_project ? `Re-opened ${w.name}. All its data was restored from .octopus/` : `Project ${w.name} is ready`, {
        description: `Octopus data lives in ${w.display_path || w.path}/.octopus`,
      });
      onOpenChange(false);
      nav(`/w/${w.id}/canvas`);
    },
    onError: (e: Error) => toast.error("Could not open project", { description: e.message }),
  });

  const crumbs = React.useMemo(() => {
    if (!current) return [];
    const roots = browse.data?.roots ?? [];
    const root = roots.filter((r) => current === r || current.startsWith(r.endsWith("/") ? r : r + "/")).sort((a, b) => b.length - a.length)[0] ?? "/";
    const rest = current.slice(root.length).split("/").filter(Boolean);
    const out = [{ label: browse.data?.root_labels?.[root] || root, path: root }];
    let acc = root;
    for (const seg of rest) { acc = acc.endsWith("/") ? acc + seg : `${acc}/${seg}`; out.push({ label: seg, path: acc }); }
    return out;
  }, [current, browse.data?.roots]);

  const onKey = (e: React.KeyboardEvent) => {
    if (newFolder !== null) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(entries.length - 1, c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === "Enter" && entries[cursor]) { e.preventDefault(); setPath(entries[cursor].path); }
    else if (e.key === "Backspace" && browse.data?.parent !== undefined) { e.preventDefault(); setPath(browse.data?.parent ?? undefined); }
    else if (e.key === " " && entries[cursor]) { e.preventDefault(); setSelected(entries[cursor].path); }
  };
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2"><FolderOpen className="h-4 w-4 text-primary" />Choose a project directory</DialogTitle>
          <DialogDescription>
            Agents are sandboxed to this folder. Octopus stores everything for the project in <code className="rounded bg-muted px-1">.octopus/</code> inside it.
          </DialogDescription>
          {notice && <p className="rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">Using the built-in browser because the system folder dialog isn't available: {notice}</p>}
        </DialogHeader>

        <div className="flex items-center gap-1 border-y border-border bg-surface px-3 py-2 text-xs">
          <Button variant="ghost" size="icon-sm" aria-label="Up one level" disabled={!browse.data?.parent && !current} onClick={() => setPath(browse.data?.parent ?? undefined)}>
            <ArrowUp />
          </Button>
          <nav aria-label="Path" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <button className="rounded px-1.5 py-0.5 hover:bg-accent" onClick={() => setPath(undefined)}><HardDrive className="inline h-3.5 w-3.5" /></button>
            {crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                <button className={cn("truncate rounded px-1.5 py-0.5 hover:bg-accent", i === crumbs.length - 1 && "font-medium text-foreground")} onClick={() => setPath(c.path)}>{c.label}</button>
              </React.Fragment>
            ))}
          </nav>
          {current && (
            <Button variant="ghost" size="xs" onClick={() => setNewFolder("")}><FolderPlus />New folder</Button>
          )}
        </div>

        <form className="mx-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (goTo.trim()) { setPath(goTo.trim()); setGoTo(""); } }}>
          <Input value={goTo} onChange={(e) => setGoTo(e.target.value)} aria-label="Go to folder path" className="h-8 font-mono text-xs"
            placeholder={browse.data?.root_labels ? `Paste a folder path, e.g. ${Object.values(browse.data.root_labels)[0] ?? "/home/me/code"}` : "Paste a folder path"} />
          <Button size="sm" variant="outline" type="submit" disabled={!goTo.trim()}>Go</Button>
        </form>

        <div ref={listRef} tabIndex={0} onKeyDown={onKey} role="listbox" aria-label="Folders"
          className="mx-3 h-64 overflow-y-auto rounded-lg border border-border bg-background/40 p-1 focus-visible:ring-2">
          {newFolder !== null && (
            <form className="flex items-center gap-2 p-1.5" onSubmit={(e) => { e.preventDefault(); if (newFolder.trim()) mkdir.mutate(newFolder.trim()); }}>
              <FolderPlus className="h-4 w-4 text-primary" />
              <Input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="folder-name" className="h-7"
                onKeyDown={(e) => e.key === "Escape" && setNewFolder(null)} />
              <Button size="xs" type="submit" loading={mkdir.isPending}>Create</Button>
            </form>
          )}
          {browse.isLoading && <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>}
          {browse.isError && <p className="p-4 text-sm text-destructive">{(browse.error as Error).message}</p>}
          {!browse.isLoading && entries.length === 0 && newFolder === null && (
            <p className="p-6 text-center text-sm text-muted-foreground">No sub-folders here. Select this folder or create a new one.</p>
          )}
          {entries.map((e, i) => {
            const Icon = e.is_git ? FolderGit2 : Folder;
            const isSel = selected === e.path;
            return (
              <div key={e.path} data-idx={i} role="option" aria-selected={isSel}
                onClick={() => { setCursor(i); setSelected(e.path); }} onDoubleClick={() => setPath(e.path)}
                className={cn("group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  isSel ? "bg-primary/15 text-foreground" : i === cursor ? "bg-accent/60" : "hover:bg-accent/40")}>
                <Icon className={cn("h-4 w-4 shrink-0", e.is_project ? "text-primary" : "text-muted-foreground")} />
                <span className="truncate">{e.name}</span>
                {e.is_project && <Badge className="ml-1">Octopus project</Badge>}
                {e.is_git && <Badge variant="outline">git</Badge>}
                <button className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                  aria-label={`Open ${e.name}`} onClick={(ev) => { ev.stopPropagation(); setPath(e.path); }}>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
        <p className="px-4 text-[11px] text-muted-foreground">
          <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move · <kbd className="kbd">Enter</kbd> open · <kbd className="kbd">Space</kbd> select · <kbd className="kbd">⌫</kbd> up · double-click to open
        </p>

        <div className="space-y-3 border-t border-border bg-surface px-5 py-4">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Selected directory">
              <div className="flex h-9 items-center truncate rounded-md border border-dashed border-border px-3 font-mono text-xs text-muted-foreground" title={display(target)}>
                {target ? display(target) : "Browse to a folder…"}
              </div>
            </Field>
            <Field label="Project name"><Input value={name} onChange={(e) => setName(e.target.value)} className="w-48" placeholder="my-app" /></Field>
          </div>
          <Field label="Default permission level" hint="You can change it per run, and restrict individual agents further.">
            <PermissionPicker value={perm} onChange={setPerm} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!target} loading={create.isPending} onClick={() => create.mutate()}>
              <FolderOpen />Use this folder
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
