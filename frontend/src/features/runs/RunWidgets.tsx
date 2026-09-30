import * as React from "react";
import { Coins, Cpu, Gauge, Radio, Timer } from "lucide-react";
import { cn, formatCost, formatTokens } from "@/lib/utils";
import type { AgentOut } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Tip } from "@/components/ui/overlays";
import type { LiveTask, RunLive, TimelineItem } from "./runState";

function Meter({ icon: Icon, label, value, max, fmt }: { icon: typeof Cpu; label: string; value: number; max?: number; fmt: (n: number) => string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  const tone = pct > 90 ? "bg-destructive" : pct > 70 ? "bg-warning" : "bg-primary";
  return (
    <Tip content={`${label}: ${fmt(value)}${max ? ` of ${fmt(max)}` : ""}`} side="bottom">
      <div className="flex min-w-[88px] flex-col gap-0.5" aria-label={label}>
        <div className="flex items-center gap-1 text-[11px] tabular-nums"><Icon className="h-3 w-3 text-muted-foreground" /><span className="font-medium">{fmt(value)}</span>
          {max ? <span className="text-muted-foreground">/ {fmt(max)}</span> : null}</div>
        {max ? <div className="h-1 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full transition-all duration-500", tone)} style={{ width: `${pct}%` }} /></div> : null}
      </div>
    </Tip>
  );
}

export function UsageMeter({ usage }: { usage: RunLive["usage"] }) {
  return (
    <div className="flex items-center gap-4">
      <Meter icon={Gauge} label="Turns" value={usage.turns} max={usage.max_turns} fmt={String} />
      <Meter icon={Cpu} label="Tokens" value={usage.tokens} max={usage.max_tokens} fmt={formatTokens} />
      <Meter icon={Coins} label="Cost" value={usage.cost_usd} max={usage.max_cost_usd || undefined} fmt={formatCost} />
      {usage.timeout_s ? <Meter icon={Timer} label="Active time" value={Math.round(usage.active_seconds ?? 0)} max={usage.timeout_s} fmt={(n) => `${n}s`} /> : null}
    </div>
  );
}

const COLS = [["todo", "To do"], ["in_progress", "In progress"], ["in_review", "In review"], ["done", "Done"], ["blocked", "Blocked"]] as const;

export function TaskBoard({ tasks, agents }: { tasks: LiveTask[]; agents: Record<string, AgentOut> }) {
  if (!tasks.length) return <p className="py-10 text-center text-sm text-muted-foreground">No tasks on the board yet. Managers create them when delegating.</p>;
  return (
    <div className="grid grid-cols-2 gap-2 p-3 xl:grid-cols-3">
      {COLS.map(([k, label]) => {
        const list = tasks.filter((t) => t.status === k);
        if (k === "blocked" && !list.length) return null;
        return (
          <div key={k} className="rounded-lg border border-border bg-muted/20 p-2">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {label}<span className="rounded bg-muted px-1.5 tabular-nums">{list.length}</span>
            </div>
            <div className="space-y-1.5">
              {list.map((t) => {
                const a = t.assignee_agent_id ? agents[t.assignee_agent_id] : undefined;
                return (
                  <div key={t.key} className="rounded-md border border-border bg-elevated p-2 text-xs shadow-sm animate-fade-up" title={t.description}>
                    <div className="flex items-center gap-1.5"><span className="font-mono text-[10px] text-muted-foreground">{t.key}</span>
                      {a && <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground"><AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={14} />{a.name}</span>}</div>
                    <p className="mt-1 font-medium leading-snug">{t.title}</p>
                    {t.acceptance_criteria && <p className="mt-1 line-clamp-2 text-[10.5px] text-muted-foreground">{t.acceptance_criteria}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TONE: Record<TimelineItem["tone"], string> = {
  msg: "bg-sky-400", protocol: "bg-rose-400", file: "bg-emerald-400", tool: "bg-amber-400", status: "bg-muted-foreground", error: "bg-destructive", approval: "bg-warning", org: "bg-fuchsia-400",
};

/** Timeline scrubber over persisted events. `cursor === null` means live. */
export function Timeline({ items, maxSeq, cursor, onCursor, agents, live }: {
  items: TimelineItem[]; maxSeq: number; cursor: number | null; onCursor: (c: number | null) => void; agents: Record<string, AgentOut>; live: boolean;
}) {
  const bar = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<TimelineItem | null>(null);
  const minSeq = items[0]?.seq ?? 0;
  const span = Math.max(1, maxSeq - minSeq);
  const pos = (seq: number) => ((seq - minSeq) / span) * 100;
  const at = cursor ?? maxSeq;
  const idx = items.findIndex((i) => i.seq > at);
  const current = items[(idx === -1 ? items.length : idx) - 1];

  const seek = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const target = minSeq + p * span;
    const nearest = items.reduce((best, it) => (Math.abs(it.seq - target) < Math.abs(best.seq - target) ? it : best), items[0]);
    onCursor(nearest && nearest.seq >= maxSeq && live ? null : nearest?.seq ?? null);
  };
  const step = (dir: 1 | -1) => {
    const i = items.findIndex((it) => it.seq >= at);
    const cur = i === -1 ? items.length - 1 : items[i].seq === at ? i : i - 1;
    const next = items[Math.min(items.length - 1, Math.max(0, cur + dir))];
    if (next) onCursor(next.seq >= maxSeq && live ? null : next.seq);
  };

  return (
    <div className="flex items-center gap-3 border-t border-border bg-surface px-3 py-2" role="group" aria-label="Run timeline">
      <button onClick={() => onCursor(null)} className={cn("flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold transition",
        cursor === null ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground hover:text-foreground")} aria-pressed={cursor === null}>
        <Radio className={cn("h-3 w-3", cursor === null && live && "animate-pulse")} />{live ? "Live" : "End"}
      </button>
      <div ref={bar} tabIndex={0} className="relative h-7 flex-1 cursor-pointer select-none rounded focus-visible:ring-2"
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); seek(e.clientX); }}
        onPointerMove={(e) => { if (e.buttons === 1) seek(e.clientX); }}
        onKeyDown={(e) => { if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); } if (e.key === "ArrowRight") { e.preventDefault(); step(1); } }}
        aria-label="Scrub timeline (arrow keys step)" role="slider" aria-valuemin={minSeq} aria-valuemax={maxSeq} aria-valuenow={at}>
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary/40 transition-[width] duration-150" style={{ width: `${pos(at)}%` }} />
        {items.map((it) => (
          <span key={it.seq} onPointerEnter={() => setHover(it)} onPointerLeave={() => setHover(null)}
            className={cn("absolute top-1/2 h-2.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform hover:scale-150", TONE[it.tone], it.seq > at && "opacity-30")}
            style={{ left: `${pos(it.seq)}%` }} />
        ))}
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow transition-[left] duration-150" style={{ left: `${pos(at)}%` }} />
        {hover && (
          <span className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] shadow-lg" style={{ left: `${pos(hover.seq)}%` }}>
            {hover.label}
          </span>
        )}
      </div>
      <div className="w-64 shrink-0 truncate text-[11px] text-muted-foreground" aria-live="polite">
        {current ? <>{current.agent_id && agents[current.agent_id] && <span style={{ color: agents[current.agent_id].color }} className="font-medium">● </span>}{current.label}</> : "No events yet"}
      </div>
    </div>
  );
}
