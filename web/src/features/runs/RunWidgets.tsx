import * as React from "react";
import { formatTokens } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { RunLive } from "./runState";

/** Exact usage as reported by Azure (input incl. cached + cache writes, output incl. reasoning) and what it cost. */
export function UsageBreakdown({ usage, children }: { usage: RunLive["usage"]; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <UsageTable usage={usage} />
      </PopoverContent>
    </Popover>
  );
}

/** The usage tables: tokens and their cost, then what the run did. The popover and the Usage tab show the same tables. */
export function UsageTable({ usage }: { usage: RunLive["usage"] }) {
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
    <>
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
    <table className="w-full text-xs tabular-nums">
      <thead><tr className="border-t border-border text-[10px] uppercase tracking-wide text-muted-foreground"><th className="px-3 py-1.5 text-left font-medium">Execution</th><th className="px-2 text-right font-medium">Count</th><th className="px-3 text-right font-medium"> </th></tr></thead>
      <tbody>
        {([
          ["Agent turns", usage.agent_runs, `${usage.llm_calls ?? 0} model calls`],
          ["Tool calls", usage.tool_calls, usage.tool_failures ? `${usage.tool_failures} failed` : undefined],
          ["Searches", usage.searches, undefined],
          ["Folder listings", usage.listings, undefined],
          ["Files read", usage.file_reads, usage.redundant_reads ? `${usage.redundant_reads} already in context` : undefined],
          ["Files changed", usage.files_changed, usage.file_writes ? `${usage.file_writes} write operations` : undefined],
          ["Checks run", usage.verifications, undefined],
          ["Model time", usage.model_ms ? Math.round(usage.model_ms / 1000) : 0, usage.model_ms ? "seconds" : undefined],
        ] as [string, number | undefined, string | undefined][]).map(([label, n, hint]) => (
          <tr key={label} className="border-t border-border/60">
            <td className="px-3 py-1.5">{label}{hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}</td>
            <td className="px-2 text-right">{(n ?? 0).toLocaleString()}</td>
            <td className="px-3 text-right" />
          </tr>
        ))}
      </tbody>
    </table>
    <p className="border-t border-border px-3 py-2 text-[10.5px] leading-snug text-muted-foreground">
      gpt-6-luna Standard: $0.10 input, $0.01 cached, $0.125 cache writes, $0.50 output per 1M tokens (prompts over 272K: 2× input, 1.5× output). Change rates in Settings › Model › Advanced.
    </p>
    </>
  );
}

