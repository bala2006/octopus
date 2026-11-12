import * as React from "react";
import { Crown, Moon, Sparkles } from "lucide-react";
import { statusMeta } from "@/lib/meta";
import { cn, formatTokens } from "@/lib/utils";
import { deptColor, type DeptMeta } from "@/stores/canvas";
import type { AgentOut } from "@/types";
import { AgentAvatar, StatusPill } from "@/components/common";
import type { RunLive } from "./runState";

type Filter = "all" | "working" | "idle" | "inactive";

/** Everyone in the run grouped by department, with live / idle / done / inactive state and who hired whom. */
export function TeamView({ agents, state, departments }: { agents: AgentOut[]; state: RunLive; departments: Record<string, DeptMeta> }) {
  const [filter, setFilter] = React.useState<Filter>("all");
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const bucket = (a: AgentOut): Filter => (a.active === false ? "inactive" : statusMeta(state.agentStatus[a.id]).live ? "working" : "idle");
  const counts = { all: agents.length, working: 0, idle: 0, inactive: 0 } as Record<Filter, number>;
  agents.forEach((a) => counts[bucket(a)]++);
  const shown = agents.filter((a) => filter === "all" || bucket(a) === filter);
  const groups = new Map<string, AgentOut[]>();
  for (const a of shown) groups.set(a.department || "", [...(groups.get(a.department || "") ?? []), a]);
  return (
    <div className="space-y-3 p-3">
      <div className="flex gap-1" role="radiogroup" aria-label="Filter team">
        {(["all", "working", "idle", "inactive"] as Filter[]).map((f) => (
          <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
            className={cn("rounded-full border px-2.5 py-0.5 text-xs capitalize transition", filter === f ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
            {f === "working" ? "Active now" : f} <span className="tabular-nums opacity-70">{counts[f]}</span>
          </button>
        ))}
      </div>
      {[...groups.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(([dept, list]) => {
        const color = dept ? deptColor(dept, departments) : "#64748b";
        return (
          <section key={dept || "_"} className="overflow-hidden rounded-lg border" style={{ borderColor: `${color}44` }}>
            <div className="flex items-center justify-between px-3 py-1.5 text-xs font-semibold" style={{ background: `${color}14`, color }}>
              {dept || "No department"}<span className="font-normal text-muted-foreground">{list.length}</span>
            </div>
            <ul className="divide-y divide-border/60">
              {[...list].sort((a, b) => Number(!!b.is_manager) - Number(!!a.is_manager)).map((a) => {
                const off = a.active === false;
                const fresh = state.fresh[a.id] && Date.now() - state.fresh[a.id] < 4000;
                return (
                  <li key={a.id} className={cn("flex items-center gap-2.5 px-3 py-2 transition-colors", off && "opacity-55", fresh && "animate-in fade-in-0 slide-in-from-left-2 bg-steel/5")}>
                    <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} status={off ? undefined : state.agentStatus[a.id] ?? "idle"} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[13px] font-medium">
                        {a.name}
                        {a.is_manager && <Crown className="h-3 w-3 text-terracotta" aria-label="Manager" />}
                        {a.created_by && <span className="inline-flex items-center gap-0.5 rounded-full bg-steel/15 px-1.5 text-[10px] text-steel"><Sparkles className="h-2.5 w-2.5" />hired by {byId[a.created_by]?.name ?? "agent"}</span>}
                        {off && <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground"><Moon className="h-2.5 w-2.5" />inactive</span>}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{a.role}{a.reports_to && byId[a.reports_to] ? ` · reports to ${byId[a.reports_to].name}` : ""}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      {!off && <StatusPill status={state.agentStatus[a.id] ?? "idle"} activity={state.activity[a.id]} />}
                      <span className="text-[10px] tabular-nums text-muted-foreground">{formatTokens(state.usage.per_agent?.[a.id] ?? 0)} tok</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
