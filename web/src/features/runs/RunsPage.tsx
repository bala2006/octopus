import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowDownUp, GitCompare, History, Play, RotateCw, Search, Square, Trash2 } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn, formatTokens, timeAgo, duration, parseUtc } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { qk, useCompanyId, useRuns, useWorkspaceId } from "@/hooks/queries";
import type { RunOut } from "@/types";
import { ApprovalModeBadge, EmptyState, LoadingRows } from "@/components/common";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/surfaces";
import { Badge, Input } from "@/components/ui/primitives";
import { ConfirmDialog, Tip } from "@/components/ui/overlays";
import { useOpenConversation } from "@/features/conversation/useOpenConversation";
import { TERMINAL } from "./runState";
import { filterRuns, groupByDay, LIVE_STATES, outcomeFacts, outcomeOf, type RunFilter, type RunSort } from "./runsList";

const FILTERS: Array<[RunFilter, string]> = [["all", "All"], ["live", "Live"], ["finished", "Finished"], ["problems", "Needs attention"]];

export default function RunsPage() {
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const { data, isLoading } = useRuns(w, companyId || undefined, true);
  const openConversation = useOpenConversation();
  const [del, setDel] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<RunFilter>("all");
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState<RunSort>("newest");
  const qc = useQueryClient();
  const nav = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.runs(w) });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/w/{workspace_id}/runs/{run_id}", { params: { path: { workspace_id: w, run_id: id } } })),
    onSuccess: () => { refresh(); toast.success("Conversation deleted"); },
  });
  const stop = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/control/{action}", { params: { path: { workspace_id: w, run_id: id, action: "stop" } } })),
    onSuccess: () => { refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const rerun = useMutation({
    mutationFn: (r: RunOut) => unwrap(api.POST("/api/v1/w/{workspace_id}/runs", { params: { path: { workspace_id: w } }, body: {
      company_id: r.company_id, goal: r.goal, mode: r.mode as "autonomous" | "step" | "supervised", budget: r.budget as never } })),
    onSuccess: (r) => { refresh(); nav(`/w/${w}/runs/${r.id}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const shown = React.useMemo(() => filterRuns(data ?? [], filter, q, sort), [data, filter, q, sort]);
  const groups = React.useMemo(() => groupByDay(shown), [shown]);
  const counts = React.useMemo(() => Object.fromEntries(FILTERS.map(([f]) => [f, filterRuns(data ?? [], f, "", "newest").length])), [data]);

  return (
    <div className="content-page flex h-full min-h-0 flex-col">
      <PageHeader title="History" description="Every conversation in this project, with what it cost and how it ended. Open one to pick it up where you left off." />
      {!!data?.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Filter conversations" className="flex items-center gap-1">
            {FILTERS.map(([f, label]) => (
              <button key={f} role="radio" aria-checked={filter === f} onClick={() => setFilter(f)}
                className={cn("rounded-full border px-2.5 py-1 text-xs transition", filter === f ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:bg-accent")}>
                {label} <span className="tabular-nums opacity-70">{counts[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative ml-auto">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" aria-label="Search conversations by message" className="h-8 w-56 pl-7 text-xs" />
          </div>
          <Button size="sm" variant="ghost" onClick={() => setSort(sort === "newest" ? "oldest" : "newest")} aria-label={`Sort: ${sort} first`}>
            <ArrowDownUp />{sort === "newest" ? "Newest first" : "Oldest first"}
          </Button>
        </div>
      )}
      <div className="ui-surface min-h-0 overflow-y-auto" data-testid="runs-list">
        {isLoading ? <LoadingRows rows={5} /> : !data?.length ? (
          <EmptyState icon={History} title="No conversations yet" description="Send your first request in Conversation. The team lead plans the work and brings in the right agents." action={<Button onClick={() => openConversation(w, null, companyId)}><Play />Start a conversation</Button>} />
        ) : !shown.length ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No conversations match{q ? ` "${q}"` : ""}.</p>
        ) : (
          groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="sticky top-0 z-10 border-b border-border bg-surface/95 px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">{g.day}</h2>
              <ul className="divide-y divide-border">
                {g.runs.map((r) => (
                  <RunRow key={r.id} r={r} w={w} onDelete={() => setDel(r.id)} onStop={() => stop.mutate(r.id)} onRerun={() => rerun.mutate(r)} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete this conversation?" destructive confirmLabel="Delete"
        description="Its messages, events, tasks and artifact history are removed from .octopus. Files in your project are not touched."
        onConfirm={() => del && remove.mutate(del)} />
    </div>
  );
}

function RunRow({ r, w, onDelete, onStop, onRerun }: { r: RunOut; w: string; onDelete: () => void; onStop: () => void; onRerun: () => void }) {
  const money = useMoney();
  const out = outcomeOf(r);
  const facts = outcomeFacts(r);
  const live = LIVE_STATES.has(r.status);
  const dur = r.started_at && r.ended_at ? duration(parseUtc(r.ended_at) - parseUtc(r.started_at)) : null;
  const maxTurns = Number((r.budget as { max_turns?: number })?.max_turns ?? 0);
  const created = new Date(parseUtc(r.created_at));
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30 focus-within:bg-accent/30" data-testid={`run-row-${r.id}`}>
      <Tip content={out.caveat ?? out.label}>
        <Badge variant={out.variant} className={cn("w-24 shrink-0 justify-center gap-1", r.status === "running" && "animate-pulse")}>
          {out.caveat && <AlertTriangle className="h-3 w-3" aria-hidden />}{out.label}
        </Badge>
      </Tip>
      <Link to={`/w/${w}/runs/${r.id}`} className="min-w-0 flex-1 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="truncate text-sm font-medium">{r.goal}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <time dateTime={created.toISOString()} title={created.toLocaleString()} className="shrink-0">{timeAgo(r.created_at)}</time>
          <span>·</span><span className="shrink-0 capitalize">{r.mode}</span>{dur && <><span>·</span><span className="shrink-0">{dur}</span></>}
          {facts.length > 0 && <><span>·</span><span className="shrink-0" data-testid="run-facts">{facts.join(" · ")}</span></>}
        </div>
        {/* the halt reason explains the outcome for EVERY status, including "completed" */}
        {(out.caveat || r.halt_reason) && (
          <div className={cn("truncate text-[11px]", out.verified ? "text-muted-foreground" : "text-warning")} title={r.halt_reason || out.caveat} data-testid="run-reason">
            {[out.caveat, r.halt_reason].filter(Boolean).join(" · ")}
          </div>
        )}
        {live && maxTurns > 0 && (
          <div className="mt-1 flex items-center gap-2 text-[10.5px] text-muted-foreground" aria-label={`Model call ${r.turns} of ${maxTurns}`}>
            <div className="h-1 w-32 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (r.turns / maxTurns) * 100)}%` }} /></div>
            {r.turns}/{maxTurns} model calls
          </div>
        )}
      </Link>
      <ApprovalModeBadge mode={r.permission_level} />
      <div className="shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-muted-foreground">{r.turns} model calls · {formatTokens(r.tokens_used)} tok · {money(r.cost_usd)}</div>
      {/* always reachable (keyboard and touch); dimmed until the row is hovered or focused */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100" aria-label="Conversation actions">
        {live && <Tip content="Stop the team"><Button variant="ghost" size="icon-sm" onClick={onStop} aria-label="Stop the team"><Square /></Button></Tip>}
        <Tip content="Ask again: a new conversation with the same request and settings"><Button variant="ghost" size="icon-sm" onClick={onRerun} aria-label="Ask again"><RotateCw /></Button></Tip>
        <Tip content="Review the changes"><Button variant="ghost" size="icon-sm" asChild><Link to={`/w/${w}/artifacts/${r.id}`} aria-label="Review the changes"><GitCompare /></Link></Button></Tip>
        {TERMINAL.has(r.status) && <Tip content="Delete conversation"><Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Delete conversation"><Trash2 /></Button></Tip>}
      </div>
    </li>
  );
}
