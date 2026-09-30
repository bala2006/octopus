import * as React from "react";
import { useNodes, ViewportPortal } from "@xyflow/react";
import { Crown } from "lucide-react";
import { deptColor, type AgentNode, type DeptMeta } from "@/stores/canvas";

const PAD = 22;
const LABEL_H = 26;

/** Soft, labelled regions behind each department's agents (decoration only; agents remain the only node type). */
export function DepartmentZones({ departments, onSelect }: { departments: Record<string, DeptMeta>; onSelect?: (dept: string) => void }) {
  const nodes = useNodes<AgentNode>();
  const zones = React.useMemo(() => {
    const groups = new Map<string, AgentNode[]>();
    for (const n of nodes) {
      const d = n.data.department;
      if (!d) continue;
      groups.set(d, [...(groups.get(d) ?? []), n]);
    }
    return [...groups.entries()].map(([name, ns]) => {
      const xs = ns.map((n) => n.position.x), ys = ns.map((n) => n.position.y);
      const x2 = ns.map((n) => n.position.x + (n.measured?.width ?? 250));
      const y2 = ns.map((n) => n.position.y + (n.measured?.height ?? 130));
      const manager = ns.find((n) => n.data.is_manager);
      const active = ns.filter((n) => n.data.active !== false).length;
      return {
        name, color: deptColor(name, departments), manager: manager?.data.name, count: ns.length, active,
        x: Math.min(...xs) - PAD, y: Math.min(...ys) - PAD - LABEL_H, w: Math.max(...x2) - Math.min(...xs) + PAD * 2, h: Math.max(...y2) - Math.min(...ys) + PAD * 2 + LABEL_H,
      };
    });
  }, [nodes, departments]);
  return (
    <ViewportPortal>
      {zones.map((z) => (
        <div key={z.name} className="pointer-events-none absolute rounded-2xl border-2 border-dashed transition-all duration-300"
          style={{ transform: `translate(${z.x}px, ${z.y}px)`, width: z.w, height: z.h, borderColor: `${z.color}55`, background: `${z.color}0d`, zIndex: -1 }}
          aria-hidden>
          <button onClick={() => onSelect?.(z.name)}
            className="pointer-events-auto absolute left-3 top-1.5 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide transition hover:brightness-125"
            style={{ color: z.color, background: `${z.color}1f` }} title={`Select the ${z.name} department`}>
            <span>{z.name}</span>
            <span className="font-normal normal-case tracking-normal opacity-80">
              · {z.count} {z.count === 1 ? "agent" : "agents"}{z.active < z.count ? ` (${z.count - z.active} inactive)` : ""}
            </span>
            {z.manager && <span className="flex items-center gap-0.5 font-normal normal-case tracking-normal opacity-80"><Crown className="h-2.5 w-2.5" />{z.manager}</span>}
          </button>
        </div>
      ))}
    </ViewportPortal>
  );
}
