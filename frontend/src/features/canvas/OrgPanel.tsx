import * as React from "react";
import { useReactFlow } from "@xyflow/react";
import { ChevronRight, Crown, Moon, Pencil, Plus, Power, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEPT_PALETTE, deptColor, useCanvas, type AgentNode } from "@/stores/canvas";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlays";

/** Org chart of the company: departments → manager → members, with active/inactive state and quick actions. */
export function OrgPanel({ onAddDepartment }: { onAddDepartment: () => void }) {
  const nodes = useCanvas((s) => s.nodes);
  const departments = useCanvas((s) => s.departments);
  const rf = useReactFlow();
  const groups = React.useMemo(() => {
    const m = new Map<string, AgentNode[]>();
    for (const n of nodes) m.set(n.data.department || "", [...(m.get(n.data.department || "") ?? []), n]);
    return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map(([name, ns]) => ({ name, nodes: [...ns].sort((a, b) => Number(!!b.data.is_manager) - Number(!!a.data.is_manager) || a.data.name.localeCompare(b.data.name)) }));
  }, [nodes]);
  const active = nodes.filter((n) => n.data.active !== false).length;

  const focus = (ids: string[], open?: string) => {
    useCanvas.setState({ nodes: useCanvas.getState().nodes.map((n) => ({ ...n, selected: ids.includes(n.id) })) });
    rf.fitView({ nodes: ids.map((id) => ({ id })), padding: ids.length > 1 ? 0.5 : 1.2, duration: 400, maxZoom: 1.2 });
    if (open) useCanvas.getState().setQuickConfig(open);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
        <span><span className="font-semibold text-foreground">{active}</span> active · {nodes.length - active} inactive</span>
        <Button variant="ghost" size="xs" onClick={onAddDepartment} data-testid="add-department"><Plus />Department</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2" role="tree" aria-label="Org chart">
        {groups.map((g) => <DeptGroup key={g.name || "__none"} name={g.name} nodes={g.nodes} color={g.name ? deptColor(g.name, departments) : "#64748b"} onFocus={focus} />)}
        {!nodes.length && <p className="p-4 text-center text-xs text-muted-foreground">No agents yet. Add a department to start.</p>}
      </div>
    </div>
  );
}

function DeptGroup({ name, nodes, color, onFocus }: { name: string; nodes: AgentNode[]; color: string; onFocus: (ids: string[], open?: string) => void }) {
  const [open, setOpen] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const rename = useCanvas((s) => s.renameDepartment);
  const setMeta = useCanvas((s) => s.setDepartmentMeta);
  const update = useCanvas((s) => s.updateAgent);
  const inactive = nodes.filter((n) => n.data.active === false).length;
  return (
    <div className="rounded-lg border border-border/60 bg-background/40" role="treeitem" aria-expanded={open} aria-label={name || "No department"}>
      <div className="group flex items-center gap-1.5 px-1.5 py-1">
        <button onClick={() => setOpen(!open)} className="rounded p-0.5 text-muted-foreground hover:bg-accent" aria-label={open ? "Collapse" : "Expand"}>
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        {name ? (
          <Popover>
            <PopoverTrigger asChild><button className="h-3 w-3 shrink-0 rounded-full ring-offset-1 ring-offset-background transition hover:ring-2" style={{ background: color, ["--tw-ring-color" as string]: color }} aria-label="Department color" /></PopoverTrigger>
            <PopoverContent className="w-auto p-2" side="right">
              <div className="grid grid-cols-5 gap-1.5">{DEPT_PALETTE.map((c) => <button key={c} onClick={() => setMeta(name, { color: c })} className="h-6 w-6 rounded-full transition hover:scale-110" style={{ background: c }} aria-label={c} />)}</div>
            </PopoverContent>
          </Popover>
        ) : <span className="h-3 w-3 shrink-0 rounded-full border border-dashed border-muted-foreground" />}
        {editing ? (
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="h-6 text-xs"
            onBlur={() => { rename(name, draft); setEditing(false); }} onKeyDown={(e) => { if (e.key === "Enter") { rename(name, draft); setEditing(false); } if (e.key === "Escape") setEditing(false); }} />
        ) : (
          <button onClick={() => onFocus(nodes.map((n) => n.id))} onDoubleClick={() => name && setEditing(true)} className="min-w-0 flex-1 truncate text-left text-xs font-semibold" style={name ? { color } : undefined}>
            {name || "No department"}
          </button>
        )}
        <span className="text-[10px] tabular-nums text-muted-foreground">{nodes.length}{inactive ? ` · ${inactive} off` : ""}</span>
        {name && !editing && <button onClick={() => { setDraft(name); setEditing(true); }} className="rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent group-hover:opacity-100" aria-label={`Rename ${name}`}><Pencil className="h-3 w-3" /></button>}
      </div>
      {open && (
        <div className="space-y-px pb-1">
          {nodes.map((n) => {
            const off = n.data.active === false;
            return (
              <div key={n.id} className={cn("group/row flex items-center gap-1.5 rounded-md py-1 pl-6 pr-1.5 transition hover:bg-accent/50", off && "opacity-55")}>
                <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => onFocus([n.id], n.id)}>
                  <AgentAvatar name={n.data.name} color={n.data.color} avatar={n.data.avatar} size={20} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 truncate text-[12px] font-medium">
                      {n.data.name}
                      {n.data.is_manager && <Crown className="h-2.5 w-2.5 shrink-0 text-amber-400" aria-label="Manager" />}
                      {n.data.created_by && <Sparkles className="h-2.5 w-2.5 shrink-0 text-fuchsia-400" aria-label="Hired by an agent" />}
                    </span>
                    <span className="block truncate text-[10.5px] text-muted-foreground">{n.data.role}</span>
                  </span>
                </button>
                <Tip content={off ? "Inactive: click to activate" : "Active: click to deactivate"}>
                  <button onClick={() => update(n.id, { active: off }, { history: true })} aria-label={off ? `Activate ${n.data.name}` : `Deactivate ${n.data.name}`}
                    className={cn("rounded p-0.5 transition", off ? "text-muted-foreground hover:text-success" : "text-success/80 opacity-0 hover:text-destructive group-hover/row:opacity-100")}>
                    {off ? <Moon className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                  </button>
                </Tip>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
