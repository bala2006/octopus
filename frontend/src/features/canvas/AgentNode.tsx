import * as React from "react";
import { tone } from "@/lib/palette";
import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { Crown, Flag, MessageSquare, Moon, Plug, Settings2, ShieldAlert, Sparkles } from "lucide-react";
import { AgentAvatar, StatusPill, TypingDots } from "@/components/common";
import { MESSAGE_TYPE_LABEL, PERMISSIONS, TOOLS, statusMeta } from "@/lib/meta";
import { cn, formatTokens } from "@/lib/utils";
import { deptColor, useCanvas, type AgentNode as AgentNodeT } from "@/stores/canvas";
import type { PermissionLevel } from "@/types";
import { Tip } from "@/components/ui/overlays";
import { useEditable, useLive } from "./live";
import { NodeQuickConfig } from "./NodeQuickConfig";
import { useEffectiveModel } from "./ModelPicker";

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

function AgentNodeImpl({ id, data, selected }: NodeProps<AgentNodeT>) {
  const live = useLive();
  const editable = useEditable();
  const quickId = useCanvas((s) => s.quickConfigId);
  const setQuick = useCanvas((s) => s.setQuickConfig);
  const setInspector = useCanvas((s) => s.setInspector);
  const status = live?.status[id] ?? (live ? "idle" : undefined);
  const activity = live?.activity[id];
  const meta = statusMeta(status);
  const streaming = live?.streaming[id];
  const last = live?.lastMessage[id];
  const tools = TOOLS.filter((t) => (data.tools as Record<string, unknown>)?.[t.key]);
  const mcpCount = ((data.tools as { mcp_servers?: string[] })?.mcp_servers ?? []).length;
  const perm = data.permission_level && data.permission_level !== "inherit" ? PERMISSIONS[data.permission_level as PermissionLevel] : null;
  const departments = useCanvas((s) => s.departments);
  const creatorName = useCanvas((s) => (data.created_by ? s.nodes.find((n) => n.id === data.created_by)?.data.name : undefined));
  const inactive = data.active === false;
  const runModel = useEffectiveModel(data.provider, data.model);
  const glowing = !!status && meta.live && !inactive;
  const showQuick = editable && quickId === id;
  const dcolor = data.department ? tone(live?.departments?.[data.department]?.color ?? deptColor(data.department, departments)) : null;
  const hiredBy = data.created_by ? (live?.names?.[data.created_by] ?? creatorName ?? "an agent") : null;

  return (
    <>
      <div
        className={cn(
          "group relative w-[250px] rounded-xl border bg-elevated text-left shadow-md transition-[box-shadow,transform,border-color] duration-200",
          "hover:shadow-xl",
          selected ? "border-primary/70" : "border-border",
          glowing && "scale-[1.02]",
          inactive && "border-dashed opacity-55 grayscale-[70%]",
          live?.fresh?.[id] && "animate-in zoom-in-75 fade-in-0 duration-500",
        )}
        style={glowing ? { boxShadow: `0 0 0 1px ${meta.color}66, 0 10px 36px -8px ${meta.color}88` } : undefined}
        onDoubleClick={() => editable && setInspector(id)}
        data-testid={`agent-node-${data.name}`}
        aria-label={`${data.name}, ${data.role}${status ? `, ${meta.label}` : ""}`}
      >
        <div className="h-1 rounded-t-xl" style={{ background: `linear-gradient(90deg, ${tone(data.color)}, ${tone(data.color)}55)` }} />
        {(dcolor || hiredBy || inactive) && (
          <div className="flex items-center gap-1 px-3 pt-2">
            {dcolor && (
              <span className="inline-flex max-w-[150px] items-center gap-1 truncate rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
                style={{ background: `${dcolor}22`, color: dcolor }}>
                {data.is_manager && <Crown className="h-2.5 w-2.5 shrink-0" />}<span className="truncate">{data.department}</span>
              </span>
            )}
            {hiredBy && <Tip content={`Hired by ${hiredBy} during a run`}><span className="inline-flex items-center gap-0.5 rounded-full bg-steel/15 px-1.5 py-px text-[9.5px] font-semibold text-steel"><Sparkles className="h-2.5 w-2.5" />AI hire</span></Tip>}
            {inactive && <span className="ml-auto inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-px text-[9.5px] font-semibold uppercase text-muted-foreground"><Moon className="h-2.5 w-2.5" />Inactive</span>}
          </div>
        )}
        <div className="flex items-start gap-2.5 p-3 pb-2">
          <AgentAvatar name={data.name} color={data.color} avatar={data.avatar} status={status} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{data.name}</span>
              {data.is_manager && !dcolor && <Tip content="Manager"><Crown className="h-3 w-3 shrink-0 text-terracotta" /></Tip>}
              {data.is_entry && (
                <Tip content="Entry agent: receives the company goal"><span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-primary"><Flag className="h-2.5 w-2.5" />Entry</span></Tip>
              )}
            </div>
            <div className="truncate text-xs text-muted-foreground">{data.role || "No role"}</div>
          </div>
          {editable && (
            <button onClick={(e) => { e.stopPropagation(); setQuick(showQuick ? null : id); }}
              className={cn("nodrag rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100", showQuick && "bg-accent text-foreground opacity-100")}
              aria-label={`Configure ${data.name}`}>
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="space-y-2 px-3 pb-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="max-w-[140px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title={runModel}>{runModel}</span>
            {perm && <Tip content={`Permission: ${perm.label}`}><span className={cn("rounded bg-muted p-0.5", perm.tone)}><perm.icon className="h-3 w-3" /></span></Tip>}
            <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
              {tools.slice(0, 6).map((t) => (
                <Tip key={t.key} content={t.label}><span className={cn("rounded p-0.5", t.danger && "text-warning/90")}><t.icon className="h-3 w-3" /></span></Tip>
              ))}
              {mcpCount > 0 && <Tip content={`${mcpCount} MCP server(s)`}><span className="flex items-center rounded p-0.5 text-olive"><Plug className="h-3 w-3" /><span className="text-[9px]">{mcpCount}</span></span></Tip>}
            </div>
          </div>

          {live ? (
            <div className="space-y-1.5 border-t border-border/70 pt-2">
              <div className="flex items-center justify-between gap-2">
                <StatusPill status={status} activity={activity} />
                {!!live.tokens[id] && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{formatTokens(live.tokens[id])} tok</span>}
              </div>
              {streaming && meta.live ? (
                <div className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5">
                  <TypingDots color={meta.color} className="mt-1.5" />
                  <p className="line-clamp-2 break-all font-mono text-[10px] leading-snug text-muted-foreground">{streaming.slice(-140)}</p>
                </div>
              ) : last ? (
                <div className="flex items-start gap-1.5 rounded-md bg-muted/40 px-2 py-1.5 animate-fade-up" key={last.text.slice(0, 30)}>
                  <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground/80">{MESSAGE_TYPE_LABEL[last.type] ?? last.type}{last.to ? ` → ${last.to}` : ""}:</span> {last.text}
                  </p>
                </div>
              ) : null}
              {live.pendingApprovalAgent === id && (
                <div className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
                  <ShieldAlert className="h-3 w-3 animate-pulse" />Waiting for your approval
                </div>
              )}
            </div>
          ) : (
            data.description && <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">{data.description}</p>
          )}
        </div>

        {SIDES.map((p) => (
          <Handle key={p} id={p} type="source" position={p} isConnectable={editable}
            className={cn("opacity-0 transition-opacity group-hover:opacity-100", selected && "opacity-100")} />
        ))}
      </div>
      {showQuick && (
        <NodeToolbar isVisible position={Position.Right} offset={14} align="start" className="nodrag nowheel">
          <NodeQuickConfig id={id} data={data} onClose={() => setQuick(null)} />
        </NodeToolbar>
      )}
    </>
  );
}

export const AgentNode = React.memo(AgentNodeImpl);
