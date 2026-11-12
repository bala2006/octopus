/**
 * The conversation's live state in one strip under the tabs: the workflow phases, what the team is doing, what it
 * has cost so far, and the pause / step controls. Stopping lives on the send button, so it is not repeated here.
 */
import { Coins, Footprints, Hourglass, Pause, Play } from "lucide-react";
import { cn, formatTokens } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import type { AgentOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/overlays";
import { WorkflowBar } from "@/features/runs/WorkflowBar";
import { UsageBreakdown } from "@/features/runs/RunWidgets";
import type { RunLive } from "@/features/runs/runState";

export function conversationStatus(status?: string, active = false): string {
  if (status === "awaiting_user") return "Waiting on you";
  if (status === "paused") return "Team paused";
  if (active) return status === "queued" ? "Preparing your team" : "Team is working";
  switch (status) {
    case "completed": return "Ready for your next message";
    case "incomplete": return "Ready for follow-up";
    case "failed": return "Needs attention";
    case "cancelled": return "Stopped";
    default: return status?.replace(/_/g, " ") ?? "";
  }
}

export function RunStrip({ mode, status, active, state, agents, pending, onControl }: {
  w: string;
  runId: string;
  mode: string;
  status?: string;
  active: boolean;
  state: RunLive;
  agents: Record<string, AgentOut>;
  pending: boolean;
  onControl: (action: "pause" | "resume" | "step") => void;
}) {
  const money = useMoney();
  const usage = state.usage;
  const tone = status === "awaiting_user" ? "bg-warning" : active ? "bg-primary animate-pulse" : status === "failed" ? "bg-destructive"
    : status === "incomplete" ? "bg-warning" : status === "completed" ? "bg-success" : "bg-muted-foreground";
  return (
    <div className="run-strip" data-testid="run-strip">
      {state.workflow && <WorkflowBar wf={state.workflow} agents={agents} />}
      <div className="run-strip-row">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone)} aria-hidden />
        <span className="truncate">{conversationStatus(status, active)}</span>
        {state.reason && !active && <span className="truncate text-warning">· {state.reason}</span>}
        <span className="flex-1" />
        {active && (usage.turns_since_progress ?? 0) >= 5 && (
          <Tip content={`No file changed and no task moved since call ${usage.progress_turn}`}>
            <span className="run-strip-warning"><Hourglass />{usage.turns_since_progress} calls without progress</span>
          </Tip>
        )}
        {!!(usage.tokens || usage.cost_usd) && (
          <UsageBreakdown usage={usage}>
            <button className="run-strip-usage" aria-label="Token and cost details">
              <Coins />{usage.turns} calls · {formatTokens(usage.tokens)} tok · {money(usage.cost_usd)}
            </button>
          </UsageBreakdown>
        )}
        {active && (mode === "step" ? (
          <Tip content="Let the team take one more step">
            <Button size="xs" variant="secondary" disabled={pending} onClick={() => onControl("step")} data-testid="next-turn"><Footprints />Next step</Button>
          </Tip>
        ) : (
          <Tip content={status === "paused" ? "Resume team work" : "Pause after the current step"}>
            <Button size="xs" variant="ghost" disabled={pending || status === "awaiting_user"} aria-label={status === "paused" ? "Resume team work" : "Pause team work"}
              onClick={() => onControl(status === "paused" ? "resume" : "pause")}>
              {status === "paused" ? <Play /> : <Pause />}{status === "paused" ? "Resume" : "Pause"}
            </Button>
          </Tip>
        ))}
      </div>
    </div>
  );
}
