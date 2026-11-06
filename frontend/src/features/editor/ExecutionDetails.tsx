import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Shield,
  XCircle,
} from "lucide-react";
import type { AgentOut } from "@/types";
import { qk } from "@/hooks/queries";
import { ConfirmDialog } from "@/components/ui/overlays";
import {
  executionKey,
  recoverExecution,
  useExecution,
  type RecoveryAction,
} from "./runtimeApi";
import { ScopedMemoryPanel } from "./ScopedMemoryPanel";

export function ExecutionDetails({
  workspace,
  runId,
  agents,
  companyId,
}: {
  workspace: string;
  runId: string;
  agents: Record<string, AgentOut>;
  companyId?: string;
}) {
  const execution = useExecution(workspace, runId);
  const qc = useQueryClient();
  const [confirmation, setConfirmation] = useState<RecoveryAction | null>(null);
  const recovery = useMutation({
    mutationFn: (action: RecoveryAction) =>
      recoverExecution(workspace, runId, action),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: executionKey(workspace, runId) });
      void qc.invalidateQueries({ queryKey: qk.run(workspace, runId) });
      void qc.invalidateQueries({ queryKey: ["runs", workspace] });
    },
  });
  if (execution.isPending)
    return (
      <p role="status" className="p-3 text-xs text-muted-foreground">
        Loading execution details…
      </p>
    );
  if (execution.isError)
    return (
      <div className="p-3 text-xs text-destructive" role="alert">
        Execution details could not be loaded.{" "}
        <button className="underline" onClick={() => void execution.refetch()}>
          Retry
        </button>
      </div>
    );
  const data = execution.data;
  const detail = (result: Record<string, unknown>) =>
    typeof result.error === "string"
      ? result.error
      : typeof result.reason === "string"
        ? result.reason
        : typeof result.message === "string"
          ? result.message
          : "";
  return (
    <section className="space-y-3 p-3 text-xs" aria-label="Execution details">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span>
          Lead{" "}
          <strong className="font-medium text-foreground">
            {agents[data.lead_agent_id]?.name ?? "Not assigned"}
          </strong>
        </span>
        <span className="capitalize">{data.engineering_workflow} workflow</span>
        <span>Revision {data.plan_revision}</span>
        {companyId && (
          <ScopedMemoryPanel
            workspace={workspace}
            companyId={companyId}
            runId={runId}
            agents={Object.values(agents).map((agent) => ({
              id: agent.id,
              name: agent.name,
            }))}
          />
        )}
      </div>
      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <Shield className="mt-0.5 h-3 w-3 shrink-0" />
        {data.execution_mode === "trusted_host"
          ? "Trusted host. Agents use your computer’s permissions; separate sessions are not a security sandbox."
          : `Execution mode: ${data.execution_mode}.`}
      </p>
      {(data.attempts.some(
        (attempt) => attempt.state === "recovery_required",
      ) ||
        data.requests.some(
          (request) => request.state === "recovery_required",
        )) && (
        <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-2.5">
          <p className="font-medium">Interrupted execution needs review</p>
          <p className="text-muted-foreground">
            A worker may have changed files or run commands before the
            interruption. Inspect those effects before choosing to continue or
            retry.
          </p>
          {data.requests
            .filter((request) => request.state === "recovery_required")
            .map((request) => (
              <div
                key={request.id}
                className="space-y-1 border-t border-border pt-2"
              >
                <p className="truncate" title={request.content}>
                  {request.content}
                </p>
                <div className="flex gap-3">
                  <button
                    className="underline"
                    disabled={recovery.isPending}
                    onClick={() =>
                      setConfirmation({
                        requestId: request.id,
                        action: "retry",
                      })
                    }
                  >
                    Retry message
                  </button>
                  <button
                    className="underline"
                    disabled={recovery.isPending}
                    onClick={() =>
                      setConfirmation({
                        requestId: request.id,
                        action: "cancel",
                      })
                    }
                  >
                    Cancel message
                  </button>
                </div>
              </div>
            ))}
          {data.attempts.some(
            (attempt) => attempt.state === "recovery_required",
          ) && (
            <div className="flex gap-3">
              <button
                className="underline"
                disabled={recovery.isPending}
                onClick={() => setConfirmation({ action: "acknowledge" })}
              >
                Acknowledge effects and continue
              </button>
              <button
                className="underline"
                disabled={recovery.isPending}
                onClick={() => setConfirmation({ action: "cancel" })}
              >
                Cancel interrupted execution
              </button>
            </div>
          )}
        </div>
      )}
      {recovery.isError && (
        <p role="alert" className="text-destructive">
          {recovery.error.message}
        </p>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={
          confirmation?.action === "retry"
            ? "Retry this interrupted message?"
            : confirmation?.action === "acknowledge"
              ? "Continue after reviewing effects?"
              : "Cancel interrupted work?"
        }
        description="I have reviewed the files and commands from the interrupted attempt. Some effects may already have happened. Retrying may repeat them; cancelling does not undo them."
        confirmLabel={
          confirmation?.action === "retry"
            ? "I reviewed effects · Retry"
            : confirmation?.action === "acknowledge"
              ? "I reviewed effects · Continue"
              : "I reviewed effects · Cancel work"
        }
        destructive={confirmation?.action === "cancel"}
        onConfirm={() => {
          if (confirmation) recovery.mutate(confirmation);
          setConfirmation(null);
        }}
      />
      {(data.checkpoints.length > 0 || data.blockers.length > 0) && (
        <details open>
          <summary className="cursor-pointer font-medium">
            Workflow checkpoints
          </summary>
          <div className="mt-2 space-y-2">
            {data.blockers.length > 0 && (
              <div
                role="status"
                className="rounded-lg border border-warning/40 bg-warning/5 p-2.5"
              >
                <p className="font-medium">Waiting for required checks</p>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
                  {data.blockers.map((reason, i) => (
                    <li key={`${i}-${reason}`}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.checkpoints.map((point, i) => (
              <div
                key={`${point.revision}-${point.step}-${i}`}
                className="rounded-lg border border-border p-2.5"
              >
                <div className="flex justify-between gap-2">
                  <strong className="font-medium capitalize">
                    {point.step.replaceAll("_", " ")}
                  </strong>
                  <span className="text-muted-foreground">
                    {point.revision !== data.plan_revision
                      ? "Stale"
                      : point.status === "recorded"
                        ? "Recorded"
                        : "Unknown"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {agents[point.owner]?.name ?? point.owner} · Revision{" "}
                  {point.revision}
                  {point.tool_call_ids.length > 0
                    ? ` · ${point.tool_call_ids.length} tool records`
                    : ""}
                </p>
                {Object.entries(point.outputs).map(([key, value]) => (
                  <p key={key} className="mt-1 break-words text-[11px]">
                    <span className="text-muted-foreground">
                      {key.replaceAll("_", " ")}:{" "}
                    </span>
                    {value}
                  </p>
                ))}
                {point.unavailable && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {point.unavailable}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <details open>
        <summary className="cursor-pointer font-medium">
          Agent execution{" "}
          <span className="text-muted-foreground">{data.attempts.length}</span>
        </summary>
        <div className="mt-2 space-y-2">
          {data.attempts.length === 0 && (
            <p className="text-muted-foreground">
              No worker attempt has started.
            </p>
          )}
          {data.attempts.map((attempt) => (
            <div
              key={attempt.id}
              className="rounded-lg border border-border px-2.5 py-2"
            >
              <div className="flex items-center justify-between gap-2">
                <strong className="font-medium">
                  {agents[attempt.agent_id]?.name ?? attempt.agent_id}
                </strong>
                <span className="text-muted-foreground">
                  {attempt.state.replaceAll("_", " ")}
                </span>
              </div>
              <p className="mt-1 break-all text-[11px] text-muted-foreground">
                {attempt.provider ? `${attempt.provider} · ` : ""}
                {attempt.model}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Thinking {attempt.effort} · Revision {attempt.revision}
              </p>
              {detail(attempt.result) && (
                <p
                  className={`mt-1 break-words text-[11px] ${attempt.state === "failed" || attempt.state === "blocked" ? "text-destructive" : "text-muted-foreground"}`}
                  role={attempt.state === "failed" ? "alert" : undefined}
                >
                  {detail(attempt.result)}
                </p>
              )}
            </div>
          ))}
        </div>
      </details>
      <details open={data.evidence.length > 0}>
        <summary className="cursor-pointer font-medium">
          Verification evidence{" "}
          <span className="text-muted-foreground">{data.evidence.length}</span>
        </summary>
        <div className="mt-2 space-y-2">
          {data.evidence.length === 0 && (
            <p className="text-muted-foreground">
              No execution evidence recorded. Agent replies alone are not
              verification.
            </p>
          )}
          {data.evidence.map((item) => {
            const passed = item.current === true && item.result === "pass";
            const Icon =
              item.current === false
                ? Clock3
                : passed
                  ? CheckCircle2
                  : item.result === "fail"
                    ? XCircle
                    : AlertCircle;
            return (
              <div
                key={item.id}
                className="flex items-start gap-2 rounded-lg border border-border p-2.5"
              >
                <Icon
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${passed ? "text-success" : "text-muted-foreground"}`}
                />
                <div className="min-w-0">
                  <p className="font-medium">
                    {item.kind} ·{" "}
                    {item.current === false
                      ? "Stale"
                      : item.result === "pass" && !passed
                        ? "Unverified"
                        : item.result}
                  </p>
                  <p className="mt-0.5 break-words text-[11px] text-muted-foreground">
                    {item.check || "Details unavailable"}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    Revision {item.revision}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </details>
      {data.consultations.length > 0 && (
        <details open>
          <summary className="font-medium">Agent consultations</summary>
          <ul className="mt-2 space-y-2">
            {data.consultations.map((item) => (
              <li className="rounded-lg border border-border p-2" key={item.id}>
                <p>{item.question}</p>
                <p className="mt-1 text-muted-foreground">
                  {agents[item.from_agent]?.name ?? item.from_agent} →{" "}
                  {agents[item.to_agent]?.name ?? item.to_agent} · {item.state}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
