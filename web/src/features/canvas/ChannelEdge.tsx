import * as React from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { ArrowLeftRight, Gavel, GitPullRequest, MessageCircleQuestion, Send, TrendingUp, type LucideIcon } from "lucide-react";
import { EDGE_TYPES } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useCanvas, type ChannelEdge as ChannelEdgeT } from "@/stores/canvas";
import { useEditable, useLive } from "./live";
import { useAnchor } from "./edgeAnchors";

const ICON: Record<string, LucideIcon> = { delegate: Send, review: GitPullRequest, debate: Gavel, report: TrendingUp, consult: MessageCircleQuestion };
const ACTIVE_MS = 2600;

function ChannelEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, source }: EdgeProps<ChannelEdgeT>) {
  const live = useLive();
  const editable = useEditable();
  const setEdgeEdit = useCanvas((s) => s.setEdgeEdit);
  // floating anchors: bottom→top between levels, right→left between peers (see edgeAnchors.tsx)
  const a = useAnchor(id);
  const [path, lx, ly] = getBezierPath(a
    ? { sourceX: a.sx, sourceY: a.sy, targetX: a.tx, targetY: a.ty, sourcePosition: a.sPos, targetPosition: a.tPos, curvature: 0.25 }
    : { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.25 });
  const [hover, setHover] = React.useState(false);
  const type = data?.type ?? "delegate";
  const meta = EDGE_TYPES[type];
  const Icon = ICON[type] ?? Send;
  const act = live?.activeEdges[id];
  const [, force] = React.useState(0);
  const active = !!act && Date.now() - act.at < ACTIVE_MS;
  React.useEffect(() => {
    if (!act) return;
    const t = setTimeout(() => force((x) => x + 1), ACTIVE_MS + 50);
    return () => clearTimeout(t);
  }, [act]);
  const reverse = active && act!.from !== source; // message flowing target → source on a bidirectional edge
  const markerId = `m-${id}`;

  return (
    <>
      <defs>
        <marker id={`${markerId}-end`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={meta.color} />
        </marker>
      </defs>
      <BaseEdge id={id} path={path} interactionWidth={18}
        markerEnd={`url(#${markerId}-end)`} markerStart={data?.bidirectional ? `url(#${markerId}-end)` : undefined}
        style={{ stroke: meta.color, strokeWidth: selected || active ? 2.6 : 1.6, strokeDasharray: meta.dash, opacity: live && !active ? 0.45 : 0.9 }} />
      {active && (
        <>
          <path d={path} fill="none" stroke={meta.color} strokeWidth={6} strokeOpacity={0.18} className="pointer-events-none" />
          <path d={path} fill="none" stroke={meta.color} strokeWidth={2.4} strokeDasharray="6 6" className="pointer-events-none animate-dash-flow"
            style={reverse ? { animationDirection: "reverse" } : undefined} />
          <circle r={4.5} fill={meta.color} className="pointer-events-none" style={{ filter: `drop-shadow(0 0 6px ${meta.color})` }}>
            <animateMotion dur="1.1s" repeatCount="indefinite" path={path} keyPoints={reverse ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
          </circle>
        </>
      )}
      <EdgeLabelRenderer>
        <button
          className={cn(
            "nodrag nopan pointer-events-auto absolute flex items-center gap-1 rounded-full border bg-elevated px-1.5 py-0.5 text-[10px] font-medium shadow-sm transition-all",
            (hover || selected || active) && "z-10 px-2",
            "hover:scale-105 hover:shadow-md",
            selected && "ring-2 ring-primary",
            active && "scale-110 shadow-lg",
            !editable && "cursor-default",
          )}
          style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)`, borderColor: `${meta.color}66`, color: meta.color }}
          onClick={(e) => { e.stopPropagation(); if (editable) setEdgeEdit(id); }}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
          aria-label={`${meta.label} channel${data?.label ? `: ${data.label}` : ""}`}
          title={meta.description}
        >
          <Icon className="h-3 w-3" />
          {(hover || selected || active) && <span className="max-w-[120px] truncate">{data?.label || meta.label}</span>}
          {data?.bidirectional && (hover || selected) && <ArrowLeftRight className="h-2.5 w-2.5 opacity-70" />}
          {active && <span className="ml-0.5 rounded bg-current/10 px-1 text-[9px] uppercase tracking-wide">{act!.type.replace("_", " ")}</span>}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const ChannelEdge = React.memo(ChannelEdgeImpl);
