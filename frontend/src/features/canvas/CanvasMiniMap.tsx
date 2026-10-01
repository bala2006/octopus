import * as React from "react";
import { MiniMap, Panel, useNodes, useReactFlow, type MiniMapNodeProps } from "@xyflow/react";
import { ChevronDown, Map as MapIcon } from "lucide-react";
import { tone } from "@/lib/palette";
import { STATUS, statusMeta } from "@/lib/meta";
import { cn } from "@/lib/utils";
import type { AgentNode, DeptMeta } from "@/stores/canvas";
import { departmentZones, type Zone } from "./DepartmentZones";
import { useLive, type LiveOverlay } from "./live";

/**
 * Company overview: each agent is a block filled with its LIVE STATUS colour (the one thing the canvas can't show at a
 * glance for a whole team), outlined in its own accent colour, labelled with its initials, with department regions
 * behind and a crown dot on the entry agent. The current viewport is outlined. Click an agent to select and center it.
 */

const STORAGE_KEY = "octopus.minimap.open";

export function initials(name = ""): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Statuses present among the agents (legend entries), in a stable order. */
export function presentStatuses(ids: string[], status: Record<string, string> | undefined): string[] {
  if (!status) return [];
  const seen = new Set(ids.map((id) => status[id] ?? "idle"));
  return (Object.keys(STATUS) as string[]).filter((s) => seen.has(s));
}

/** Accessible description of what the minimap shows. */
export function minimapSummary(nodes: Pick<AgentNode, "id" | "data">[], live: Pick<LiveOverlay, "status"> | null): string {
  const n = nodes.length;
  let text = `Minimap of ${n} agent${n === 1 ? "" : "s"}`;
  if (live) {
    const counts = new Map<string, number>();
    for (const x of nodes) {
      const label = statusMeta(live.status[x.id] ?? "idle").label.toLowerCase();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    text += ": " + [...counts.entries()].map(([label, c]) => `${c} ${label}`).join(", ");
  }
  return `${text}. Click an agent to select and center it.`;
}

interface Ctx { live: LiveOverlay | null; byId: Map<string, AgentNode>; zoneFor: Map<string, Zone> }
const MiniCtx = React.createContext<Ctx>({ live: null, byId: new Map(), zoneFor: new Map() });

function MiniNode({ id, x, y, width, height, selected, onClick }: MiniMapNodeProps) {
  const { live, byId, zoneFor } = React.useContext(MiniCtx);
  const node = byId.get(id);
  if (!node) return null;
  const d = node.data;
  const status = live ? live.status[id] ?? "idle" : undefined;
  const meta = statusMeta(status);
  const identity = tone(d.color);
  const zone = zoneFor.get(id); // drawn once per department, behind its first agent
  const stroke = Math.max(6, height * 0.07);
  const inactive = d.active === false;
  return (
    <g onClick={(e) => onClick?.(e, id)} className="cursor-pointer" opacity={inactive ? 0.45 : 1} data-testid={`minimap-node-${d.name}`}>
      {zone && <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx={24} fill={zone.color} fillOpacity={0.1} stroke={zone.color}
        strokeOpacity={0.55} strokeWidth={4} strokeDasharray="14 10" pointerEvents="none" />}
      <rect x={x} y={y} width={width} height={height} rx={14} fill={status ? meta.color : "hsl(var(--elevated))"} fillOpacity={status ? 0.9 : 1}
        stroke={selected ? "hsl(var(--primary))" : identity} strokeWidth={selected ? stroke * 1.6 : stroke}
        className={cn(status && meta.live && "animate-pulse")} />
      {d.is_entry && <circle cx={x + width - height * 0.16} cy={y + height * 0.16} r={height * 0.1} fill="hsl(var(--primary))" stroke="white" strokeWidth={3} />}
      <text x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central" fontSize={height * 0.42} fontWeight={700}
        fill={status ? "white" : "hsl(var(--foreground))"} pointerEvents="none" style={{ userSelect: "none" }}>{initials(d.name)}</text>
      <title>{`${d.name}${d.role ? ` · ${d.role}` : ""}${d.department ? ` · ${d.department}` : ""}${d.is_entry ? " · entry agent" : ""}${status ? ` · ${meta.label}` : ""}${inactive ? " · inactive" : ""}`}</title>
    </g>
  );
}

export function CanvasMiniMap({ departments, onPick }: { departments: Record<string, DeptMeta>; onPick?: (id: string) => void }) {
  const live = useLive();
  const nodes = useNodes<AgentNode>();
  const rf = useReactFlow();
  const [open, setOpen] = React.useState(() => localStorage.getItem(STORAGE_KEY) !== "0");
  React.useEffect(() => { localStorage.setItem(STORAGE_KEY, open ? "1" : "0"); }, [open]);
  const ctx = React.useMemo<Ctx>(() => {
    const zones = departmentZones(nodes, departments);
    return { live, byId: new Map(nodes.map((n) => [n.id, n])), zoneFor: new Map(zones.map((z) => [z.first, z])) };
  }, [nodes, departments, live]);
  const legend = presentStatuses(nodes.map((n) => n.id), live?.status);
  const pick = (id: string) => {
    const n = ctx.byId.get(id);
    if (!n) return;
    onPick?.(id);
    const w = n.measured?.width ?? 250, h = n.measured?.height ?? 130;
    void rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 });
  };

  if (!open) {
    return (
      <Panel position="bottom-right">
        <button onClick={() => setOpen(true)} aria-label="Show minimap" title="Show minimap"
          className="flex items-center gap-1.5 rounded-lg border border-border bg-popover px-2 py-1 text-[11px] text-muted-foreground shadow-md transition hover:text-foreground">
          <MapIcon className="h-3.5 w-3.5" />Minimap
        </button>
      </Panel>
    );
  }
  return (
    <MiniCtx.Provider value={ctx}>
      <Panel position="bottom-right" style={{ marginBottom: 172 }} className="nopan nowheel">
        <div className="flex w-[200px] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border bg-popover/95 px-2 py-1 text-[10px] text-muted-foreground shadow-md" aria-label="Minimap legend">
          {legend.length ? legend.map((s) => (
            <span key={s} className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm" style={{ background: STATUS[s as keyof typeof STATUS].color }} />{STATUS[s as keyof typeof STATUS].label}</span>
          )) : <span>Fill shows live status during a run</span>}
          <button onClick={() => setOpen(false)} className="ml-auto rounded p-0.5 hover:bg-accent hover:text-foreground" aria-label="Hide minimap" title="Hide minimap">
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </Panel>
      <MiniMap<AgentNode> pannable zoomable position="bottom-right" nodeComponent={MiniNode} onNodeClick={(_, n) => pick(n.id)}
        ariaLabel={minimapSummary(nodes, live)} bgColor="hsl(var(--surface))"
        maskColor="hsl(var(--background) / 0.45)" maskStrokeColor="hsl(var(--primary))" maskStrokeWidth={2}
        className="!rounded-lg !border !border-border !shadow-md" />
    </MiniCtx.Provider>
  );
}
