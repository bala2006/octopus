/** The team ledger: the shared decisions, facts and open questions agents keep with update_ledger (Tasks tab). */
import { CircleHelp, Gavel, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentOut } from "@/types";
import type { LedgerItem } from "./runState";

const ICON = { decision: Gavel, fact: Info, question: CircleHelp } as const;

export function Ledger({ items, agents }: { items: LedgerItem[]; agents: Record<string, AgentOut> }) {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return (
    <section className="space-y-1.5 px-3 pb-4" aria-label="Team ledger" data-testid="ledger">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Team ledger</h3>
      <ul className="space-y-1">
        {sorted.map((it) => {
          const Icon = ICON[it.kind] ?? Info;
          const closed = it.status === "resolved" || it.status === "superseded";
          return (
            <li key={it.id} className={cn("flex gap-2 rounded-md border border-border bg-elevated/60 px-2 py-1.5 text-xs", closed && "opacity-60")}>
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", it.status === "open" ? "text-warning" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1">
                <div className={cn("break-words", it.status === "superseded" && "line-through")}>
                  <span className="mr-1 font-mono text-[10px] text-muted-foreground">{it.id}</span>{it.text}
                </div>
                {it.note && <div className="mt-0.5 text-muted-foreground">→ {it.note}</div>}
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {it.kind} · {it.status}{it.by ? ` · ${agents[it.by]?.name ?? "agent"}` : ""}{it.turn !== undefined ? ` · t${it.turn}` : ""}
                  {it.revisions ? ` · edited ${it.revisions}×` : ""}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
