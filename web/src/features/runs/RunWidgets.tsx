import * as React from "react";
import { cn, formatTokens } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import type { AgentOut, TaskOut } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { RunLive } from "./runState";

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
          {usage.estimated_calls && usage.estimated_calls === usage.llm_calls ? "Estimated usage" : "Usage from Azure"}
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

const COLS = [["todo", "To do"], ["in_progress", "In progress"], ["review", "In review"], ["waiting", "Waiting on you"], ["done", "Done"], ["blocked", "Blocked"], ["cancelled", "Cancelled"]] as const;
const KIND: Record<string, string> = { build: "Build", fix: "Revision", review: "Review", docs: "Document", research: "Research", verify: "Checks", answer: "Answer" };

export function TaskBoard({ tasks, agents, compact = false }: { tasks: TaskOut[]; agents: Record<string, AgentOut>; compact?: boolean }) {
  if (!tasks.length) return <p className="py-10 text-center text-sm text-muted-foreground">No tasks yet. Octopus creates them when a request needs work.</p>;
  return (
    <div className={cn("grid gap-2 p-3", compact ? "grid-cols-1" : "grid-cols-2 xl:grid-cols-3")}>
      {COLS.map(([k, label]) => {
        const list = tasks.filter((t) => t.status === k);
        if ((k === "blocked" || k === "cancelled" || k === "waiting") && !list.length) return null;
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
                    <dl className="mt-2 space-y-1 border-t border-border/60 pt-1.5 text-[10.5px] text-muted-foreground">
                      <div><dt className="inline font-medium">Kind: </dt><dd className="inline">{KIND[t.kind] ?? t.kind}{t.attempts > 1 ? ` · attempt ${t.attempts}` : ""}</dd></div>
                      {!!t.depends_on.length && <div><dt className="inline font-medium">Depends on: </dt><dd className="inline">{t.depends_on.join(", ")}</dd></div>}
                      {t.result && (t.status === "done" || t.status === "blocked" || t.status === "waiting") && <div className="line-clamp-3"><dt className="inline font-medium">Result: </dt><dd className="inline">{t.result}</dd></div>}
                    </dl>
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
