import * as React from "react";
import { GripVertical, Network, Search, UsersRound } from "lucide-react";
import { useRoleTemplates } from "@/hooks/queries";
import { AgentAvatar } from "@/components/common";
import { Input } from "@/components/ui/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/overlays";
import { OrgPanel } from "./OrgPanel";

export const DND_MIME = "application/x-octopus-role";

/** Left panel: role palette (drag onto the canvas) and the org chart (departments, active/inactive agents). */
export function Palette({ onAdd, onAddDepartment }: { onAdd: (roleKey: string) => void; onAddDepartment: () => void }) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface" aria-label="Agents and org">
      <Tabs defaultValue="org" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border p-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="org"><Network />Org</TabsTrigger>
            <TabsTrigger value="roles"><UsersRound />Roles</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="org" className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"><OrgPanel onAddDepartment={onAddDepartment} /></TabsContent>
        <TabsContent value="roles" className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"><RolePalette onAdd={onAdd} /></TabsContent>
      </Tabs>
    </aside>
  );
}

function RolePalette({ onAdd }: { onAdd: (roleKey: string) => void }) {
  const { data, isLoading } = useRoleTemplates();
  const [q, setQ] = React.useState("");
  const items = (data ?? []).filter((r) => `${r.role} ${r.default_name} ${r.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label="Role palette">
      <div className="space-y-2 border-b border-border p-3">
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
    </div>
  );
}
