import * as React from "react";
import { GripVertical, Search } from "lucide-react";
import { useRoleTemplates } from "@/hooks/queries";
import { AgentAvatar } from "@/components/common";
import { Input } from "@/components/ui/primitives";
import { Tip } from "@/components/ui/overlays";

export const DND_MIME = "application/x-octopus-role";

/** Drag role templates onto the canvas (or click to add at the centre). */
export function Palette({ onAdd }: { onAdd: (roleKey: string) => void }) {
  const { data, isLoading } = useRoleTemplates();
  const [q, setQ] = React.useState("");
  const items = (data ?? []).filter((r) => `${r.role} ${r.default_name} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface" aria-label="Agent palette">
      <div className="space-y-2 border-b border-border p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agents</div>
        <div className="relative">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search roles" className="h-7 pl-7 text-xs" aria-label="Search roles" />
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {isLoading && Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-11" />)}
        {items.map((r) => (
          <Tip key={r.key} content={r.description} side="right">
            <div
              draggable
              onDragStart={(e) => { e.dataTransfer.setData(DND_MIME, r.key); e.dataTransfer.effectAllowed = "copy"; }}
              onClick={() => onAdd(r.key)}
              onKeyDown={(e) => e.key === "Enter" && onAdd(r.key)}
              role="button" tabIndex={0} aria-label={`Add ${r.role}`}
              className="group flex cursor-grab items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-all hover:border-border hover:bg-elevated hover:shadow-sm active:cursor-grabbing active:scale-[0.98]"
            >
              <AgentAvatar name={r.default_name} color={r.color} avatar={r.avatar} size={26} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{r.role}</div>
                <div className="truncate text-[10.5px] text-muted-foreground">{r.default_name}</div>
              </div>
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
            </div>
          </Tip>
        ))}
      </div>
      <p className="border-t border-border p-3 text-[10.5px] leading-snug text-muted-foreground">Drag onto the canvas, or right-click the canvas. Connect handles to create channels.</p>
    </aside>
  );
}
