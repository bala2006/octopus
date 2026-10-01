import * as React from "react";
import { tone } from "@/lib/palette";
import { Coins, Cpu, Gauge, Hourglass, Radio, Timer } from "lucide-react";
import { cn, formatTokens } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import type { AgentOut } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlays";
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
  const money = useMoney();
  return (
    <div className="flex items-center gap-4">
      <Meter icon={Gauge} label="Turns" value={usage.turns} max={usage.max_turns} fmt={String} />
      <UsageBreakdown usage={usage}>
        <button className="flex items-center gap-4 rounded-md px-1 py-0.5 transition hover:bg-accent" aria-label="Token and cost details">
          <Meter icon={Cpu} label="Tokens" value={usage.tokens} max={usage.max_tokens} fmt={formatTokens} />
          <Meter icon={Coins} label="Cost" value={usage.cost_usd} max={usage.max_cost_usd || undefined} fmt={money} />
        </button>
      </UsageBreakdown>
      {usage.timeout_s ? <Meter icon={Timer} label="Active time" value={Math.round(usage.active_seconds ?? 0)} max={usage.timeout_s} fmt={(n) => `${n}s`} /> : null}
      {(usage.turns_since_progress ?? 0) >= 5 ? (
        <Tip content={`No file changed and no task moved since turn ${usage.progress_turn}`} side="bottom">
          <span className="flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] tabular-nums text-warning" aria-label="Turns since last progress">
            <Hourglass className="h-3 w-3" />{usage.turns_since_progress} turns without progress
          </span>
        </Tip>
      ) : null}
    </div>
  );
}

/** Exact usage as reported by Azure (input incl. cached + cache writes, output incl. reasoning) and what it cost. */
export function UsageBreakdown({ usage, children }: { usage: RunLive["usage"]; children: React.ReactNode }) {
  const money = useMoney();
  const cb = usage.cost_breakdown ?? {};
  const input = usage.input_tokens ?? 0, cached = usage.cached_tokens ?? 0, written = usage.cache_write_tokens ?? 0;
  const rows: [string, number | undefined, number | undefined, string?][] = [
    ["Input (uncached)", Math.max(0, input - cached - written), cb.input],
    ["Cached input", cached, cb.cached_input, input ? `${Math.round((cached / input) * 100)}% of input` : undefined],
    ["Cache writes", written, cb.cache_write],
    ["Output", usage.output_tokens ?? 0, cb.output, usage.reasoning_tokens ? `${formatTokens(usage.reasoning_tokens)} reasoning` : undefined],
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold">
          {usage.estimated_calls && usage.estimated_calls === usage.llm_calls ? "Estimated usage (Demo Mode)" : "Usage from Azure"}
          {usage.llm_calls ? <span className="font-normal text-muted-foreground"> · {usage.llm_calls} calls{usage.estimated_calls && usage.estimated_calls !== usage.llm_calls ? `, ${usage.estimated_calls} estimated` : ""}</span> : null}
        </div>
        <table className="w-full text-xs tabular-nums">
          <thead><tr className="text-[10px] uppercase tracking-wide text-muted-foreground"><th className="px-3 py-1.5 text-left font-medium">Tokens</th><th className="px-2 text-right font-medium">Count</th><th className="px-3 text-right font-medium">Cost</th></tr></thead>
          <tbody>
            {rows.map(([label, n, c, hint]) => (
              <tr key={label} className="border-t border-border/60">
                <td className="px-3 py-1.5">{label}{hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}</td>
                <td className="px-2 text-right">{(n ?? 0).toLocaleString()}</td>
                <td className="px-3 text-right">{money(c ?? 0)}</td>
              </tr>
            ))}
            <tr className="border-t border-border font-semibold"><td className="px-3 py-1.5">Total</td><td className="px-2 text-right">{usage.tokens.toLocaleString()}</td><td className="px-3 text-right">{money(usage.cost_usd)}</td></tr>
          </tbody>
        </table>
        <p className="border-t border-border px-3 py-2 text-[10.5px] leading-snug text-muted-foreground">
          gpt-6-luna Standard: $0.10 input, $0.01 cached, $0.125 cache writes, $0.50 output per 1M tokens (prompts over 272K: 2× input, 1.5× output). Change rates in Settings › Model › Advanced.
        </p>
      </PopoverContent>
    </Popover>
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
  msg: "bg-steel", protocol: "bg-destructive", file: "bg-olive", tool: "bg-terracotta", status: "bg-muted-foreground", error: "bg-destructive", approval: "bg-warning", org: "bg-steel",
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
        {current ? <>{current.agent_id && agents[current.agent_id] && <span style={{ color: tone(agents[current.agent_id].color) }} className="font-medium">● </span>}{current.label}</> : "No events yet"}
      </div>
    </div>
  );
}
