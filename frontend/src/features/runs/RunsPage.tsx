import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { History, Play, Trash2 } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { RUN_STATUS } from "@/lib/meta";
import { cn, formatTokens, timeAgo, duration } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { qk, useCompanyId, useRuns, useWorkspaceId } from "@/hooks/queries";
import type { PermissionLevel } from "@/types";
import { EmptyState, LoadingRows, PermissionBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { ConfirmDialog, Tip } from "@/components/ui/overlays";
import { RunDialog } from "./RunDialog";
import { TERMINAL } from "./runState";

export default function RunsPage() {
  const money = useMoney();
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const { data, isLoading } = useRuns(w, companyId || undefined, true);
  const [open, setOpen] = React.useState(false);
  const [del, setDel] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/w/{workspace_id}/runs/{run_id}", { params: { path: { workspace_id: w, run_id: id } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.runs(w) }); toast.success("Run deleted"); },
  });
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col p-6">
      <div className="mb-4 flex items-center justify-between">
        <div><h1 className="text-lg font-semibold">Runs</h1><p className="text-sm text-muted-foreground">Every execution of this company: live, paused or finished. Click to watch or replay.</p></div>
        <Button onClick={() => setOpen(true)} disabled={!companyId}><Play />New run</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface">
        {isLoading ? <LoadingRows rows={5} /> : !data?.length ? (
          <EmptyState icon={History} title="No runs yet" description="Give the company a goal and watch the agents collaborate." action={<Button onClick={() => setOpen(true)} disabled={!companyId}><Play />Start first run</Button>} />
        ) : (
          <ul className="divide-y divide-border">
            {data.map((r) => {
              const st = RUN_STATUS[r.status] ?? RUN_STATUS.queued;
              const dur = r.started_at && r.ended_at ? duration(Date.parse(r.ended_at + "Z") - Date.parse(r.started_at + "Z")) : null;
              return (
                <li key={r.id} className="group relative">
                  <Link to={`/w/${w}/runs/${r.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30">
                    <Badge variant={st.variant} className={cn("w-20 justify-center", r.status === "running" && "animate-pulse")}>{st.label}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{r.goal}</div>
                      <div className="flex items-center gap-2 truncate text-[11px] text-muted-foreground">
                        <span>{timeAgo(r.created_at)}</span>·<span className="capitalize">{r.mode}</span>{dur && <>·<span>{dur}</span></>}
                        {r.halt_reason && r.status !== "completed" && <span className="truncate text-warning">· {r.halt_reason}</span>}
                      </div>
                    </div>
                    <PermissionBadge level={r.permission_level as PermissionLevel} />
                    <div className="w-40 text-right text-[11px] tabular-nums text-muted-foreground">{r.turns} turns · {formatTokens(r.tokens_used)} tok · {money(r.cost_usd)}</div>
                  </Link>
                  {TERMINAL.has(r.status) && (
                    <Tip content="Delete run">
                      <Button variant="ghost" size="icon-sm" className="absolute right-1 top-1 opacity-0 group-hover:opacity-100" onClick={() => setDel(r.id)} aria-label="Delete run"><Trash2 /></Button>
                    </Tip>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {companyId && <RunDialog open={open} onOpenChange={setOpen} companyId={companyId} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete this run?" destructive confirmLabel="Delete"
        description="Its messages, events, tasks and artifact history are removed from .octopus. Files in your project are not touched."
        onConfirm={() => del && remove.mutate(del)} />
    </div>
  );
}
