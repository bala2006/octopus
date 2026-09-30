import * as React from "react";
import { useReactFlow } from "@xyflow/react";
import { toast } from "sonner";
import { Building2, Crown, Plus, Trash2, Users } from "lucide-react";
import { useRoleTemplates, useSettings } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import { DEPT_PALETTE, useCanvas } from "@/stores/canvas";
import type { RoleTemplateOut } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Select } from "@/components/ui/overlays";

const PRESETS: Record<string, { manager: string; members: string[] }> = {
  Engineering: { manager: "eng_manager", members: ["fullstack_dev", "fullstack_dev"] },
  Product: { manager: "head_of_product", members: ["product_manager", "ux_designer"] },
  Quality: { manager: "qa_lead", members: ["qa_engineer"] },
  Operations: { manager: "devops_lead", members: ["sre"] },
  Growth: { manager: "marketing_lead", members: ["content_writer", "growth_analyst"] },
  Research: { manager: "research_director", members: ["researcher", "data_analyst"] },
  Publishing: { manager: "editor_in_chief", members: ["writer"] },
};

interface Row { roleKey: string; name: string; title: string }

function RowEditor({ row, onChange, isManager, onRemove, byKey, roleOptions }: {
  row: Row; onChange: (r: Row) => void; isManager?: boolean; onRemove?: () => void;
  byKey: Record<string, RoleTemplateOut>; roleOptions: { value: string; label: string; hint?: string }[];
}) {
  const r = byKey[row.roleKey];
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border p-2 animate-fade-up", isManager ? "border-amber-400/40 bg-amber-400/5" : "border-border")}>
      {r ? <AgentAvatar name={row.name || r.default_name} color={r.color} avatar={r.avatar} size={26} /> : null}
      {isManager && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-label="Manager" />}
      <Select value={row.roleKey} onValueChange={(v) => onChange({ ...row, roleKey: v })} options={roleOptions} className="h-8 w-44 text-xs" ariaLabel="Role template" />
      <Input value={row.title} onChange={(e) => onChange({ ...row, title: e.target.value })} placeholder={r?.role ?? "Title"} className="h-8 flex-1 text-xs" aria-label="Title" />
      <Input value={row.name} onChange={(e) => onChange({ ...row, name: e.target.value })} placeholder={r?.default_name ?? "Name"} className="h-8 w-28 text-xs" aria-label="Name" />
      {onRemove && <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove member"><Trash2 /></Button>}
    </div>
  );
}

/** Add a whole department (1 manager + 1-4 members) with auto-wired channels. */
export function DepartmentBuilder({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data: roles } = useRoleTemplates();
  const settings = useSettings();
  const rf = useReactFlow();
  const nodes = useCanvas((s) => s.nodes);
  const [name, setName] = React.useState("Engineering");
  const [color, setColor] = React.useState(DEPT_PALETTE[0]);
  const [manager, setManager] = React.useState<Row>({ roleKey: "eng_manager", name: "", title: "" });
  const [members, setMembers] = React.useState<Row[]>([]);
  const heads = nodes.filter((n) => n.data.is_entry || (n.data.is_manager && !n.data.reports_to));
  const [reportsTo, setReportsTo] = React.useState<string>("auto");
  const byKey = React.useMemo(() => Object.fromEntries((roles ?? []).map((r) => [r.key, r])), [roles]);

  const applyPreset = React.useCallback((dept: string) => {
    const p = PRESETS[dept];
    if (!p) return;
    setManager({ roleKey: p.manager, name: "", title: "" });
    setMembers(p.members.map((k, i) => ({ roleKey: k, name: "", title: k === "fullstack_dev" ? (i ? "Frontend Engineer" : "Backend Engineer") : "" })));
  }, []);
  React.useEffect(() => { if (open) { applyPreset(name); setColor(DEPT_PALETTE[Object.keys(PRESETS).indexOf(name) % DEPT_PALETTE.length] ?? DEPT_PALETTE[0]); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const roleOptions = (roles ?? []).map((r) => ({ value: r.key, label: r.role, hint: r.default_name }));
  const create = () => {
    const mgr = byKey[manager.roleKey];
    if (!mgr || !name.trim()) return;
    const rect = document.querySelector(".react-flow")?.getBoundingClientRect();
    const center = rf.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 3 });
    const target = reportsTo === "auto" ? heads[0]?.id ?? null : reportsTo === "none" ? null : reportsTo;
    const ids = useCanvas.getState().addDepartment({
      name: name.trim(), color, reportsTo: target, at: { x: center.x - 125, y: center.y },
      manager: { role: mgr, name: manager.name, roleTitle: manager.title },
      members: members.filter((m) => byKey[m.roleKey]).map((m) => ({ role: byKey[m.roleKey] as RoleTemplateOut, name: m.name, roleTitle: m.title })),
    }, { provider: settings.data?.default_provider ?? "mock", model: settings.data?.default_model ?? "mock/demo" });
    toast.success(`Added ${name} department`, { description: `${ids.length} agents with channels wired to their manager` });
    onOpenChange(false);
    setTimeout(() => rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.6, duration: 400 }), 60);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" />Add a department</DialogTitle>
          <DialogDescription>One manager plus a small team. Channels are wired automatically: manager ⇄ members, manager ⇄ the company head, and peer-manager sync.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Department name">
              <Input value={name} onChange={(e) => setName(e.target.value)} list="dept-presets" onBlur={() => PRESETS[name] && applyPreset(name)} />
            </Field>
            <datalist id="dept-presets">{Object.keys(PRESETS).map((p) => <option key={p} value={p} />)}</datalist>
            <div className="flex gap-1 pb-1" role="radiogroup" aria-label="Color">
              {DEPT_PALETTE.map((c) => (
                <button key={c} role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)}
                  className={cn("h-6 w-6 rounded-full transition-transform hover:scale-110", color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-elevated")} style={{ background: c }} />
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {Object.keys(PRESETS).map((p) => (
              <button key={p} onClick={() => { setName(p); applyPreset(p); }} className={cn("rounded-full border px-2.5 py-0.5 text-xs transition hover:border-primary/50", name === p ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{p}</button>
            ))}
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">Manager</div>
            <RowEditor row={manager} onChange={setManager} isManager byKey={byKey} roleOptions={roleOptions} />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />Members ({members.length})</span>
              <Button variant="ghost" size="xs" disabled={members.length >= 4} onClick={() => setMembers([...members, { roleKey: "specialist", name: "", title: "" }])}><Plus />Add member</Button>
            </div>
            {members.map((m, i) => (
              <RowEditor key={i} row={m} byKey={byKey} roleOptions={roleOptions} onChange={(r) => setMembers(members.map((x, j) => (j === i ? r : x)))} onRemove={() => setMembers(members.filter((_, j) => j !== i))} />
            ))}
            {!members.length && <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">No members. The manager can hire specialists at runtime (Manage team).</p>}
          </div>
          <Field label="Manager reports to">
            <Select value={reportsTo} onValueChange={setReportsTo} options={[
              { value: "auto", label: heads[0] ? `${heads[0].data.name} (company head)` : "Nobody" },
              ...heads.slice(1).map((h) => ({ value: h.id, label: h.data.name, hint: h.data.department || h.data.role })),
              { value: "none", label: "Nobody (independent department)" }]} />
          </Field>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{1 + members.length} agents · {1 + members.length > 3 ? "tip: departments work best with 2-3 people" : "good size"}</span>
          <div className="flex gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={create} disabled={!name.trim()} data-testid="create-department"><Building2 />Add department</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
