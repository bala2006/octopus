/** The run's workflow as a row of phases: who owns each, which one is running, fix rounds, skipped phases. */
import { Check, Loader2, Minus, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentOut } from "@/types";
import { Tip } from "@/components/ui/overlays";
import type { WorkflowState } from "./runState";

export function WorkflowBar({ wf, agents }: { wf: WorkflowState; agents: Record<string, AgentOut> }) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-surface/60 px-4 py-1.5" data-testid="workflow-bar" aria-label="Workflow">
      <span className="mr-1 shrink-0 text-[11px] font-medium text-muted-foreground">{wf.track ? `${wf.track[0].toUpperCase()}${wf.track.slice(1)} track` : "Intake"}</span>
      {wf.phases.map((p, i) => {
        const who = p.owner ? agents[p.owner]?.name : undefined;
        const Icon = p.status === "done" ? Check : p.status === "active" ? Loader2 : p.status === "failed" ? X : p.status === "skipped" ? Minus : null;
        return (
          <div key={`${p.key}-${i}`} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span className="h-px w-3 bg-border" aria-hidden />}
            <Tip content={p.summary || (p.status === "skipped" ? "Skipped: nobody on the team is suited to own it" : `${p.title}${who ? `: ${who}` : ""}`)}>
              <span data-status={p.status} className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                p.status === "active" && "border-primary/60 bg-primary/10 text-foreground",
                p.status === "done" && "border-success/40 text-success",
                p.status === "failed" && "border-destructive/50 text-destructive",
                (p.status === "pending" || p.status === "skipped") && "border-border text-muted-foreground",
                p.status === "skipped" && "line-through opacity-60")}>
                {Icon && <Icon className={cn("h-3 w-3", p.status === "active" && !wf.ended && "animate-spin")} />}
                {p.title}{who && p.status !== "skipped" && <span className="text-muted-foreground">· {who}</span>}
                {!!p.loops && <span className="flex items-center gap-0.5 text-warning"><RotateCcw className="h-2.5 w-2.5" />{p.loops}</span>}
              </span>
            </Tip>
          </div>
        );
      })}
    </div>
  );
}
