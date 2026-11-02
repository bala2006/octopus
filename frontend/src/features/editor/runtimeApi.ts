import { useQuery } from "@tanstack/react-query";
import { fetchRaw } from "@/lib/api";
import { parseObject, parseText as text } from "./apiParsers";

export const ENGINEERING_WORKFLOWS = [
  "auto",
  "explain",
  "fix",
  "build",
  "review",
] as const;
export type EngineeringWorkflow = (typeof ENGINEERING_WORKFLOWS)[number];

export function engineeringWorkflow(value: unknown): EngineeringWorkflow {
  switch (value) {
    case "explain":
    case "fix":
    case "build":
    case "review":
      return value;
    default:
      return "auto";
  }
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map((item) => parseObject(item, "Invalid execution response"))
    : [];
}

export interface ExecutionRequest {
  id: string;
  client_id: string;
  kind: string;
  content: string;
  target: string;
  revision: number;
  state: string;
  attachments: Record<string, unknown>[];
  created_at: string;
}
export interface ExecutionAttempt {
  id: string;
  agent_id: string;
  revision: number;
  state: string;
  provider: string;
  model: string;
  effort: string;
  workflow: string;
  result: Record<string, unknown>;
}
export interface ExecutionEvidence {
  id: string;
  attempt_id: string;
  revision: number;
  kind: string;
  result: string;
  check: string;
  current: boolean | null;
}
export interface ExecutionState {
  lead_agent_id: string;
  plan_revision: number;
  engineering_workflow: EngineeringWorkflow;
  execution_mode: string;
  requests: ExecutionRequest[];
  attempts: ExecutionAttempt[];
  evidence: ExecutionEvidence[];
  checkpoints: {
    revision: number;
    step: string;
    owner: string;
    outputs: Record<string, string>;
    tool_call_ids: string[];
    status: string;
    unavailable: string;
  }[];
  blockers: string[];
  consultations: {
    id: string;
    state: string;
    question: string;
    from_agent: string;
    to_agent: string;
  }[];
}

export function parseExecutionRequest(value: unknown): ExecutionRequest {
  const row = parseObject(value, "Invalid execution response");
  if (
    typeof row.id !== "string" ||
    typeof row.content !== "string" ||
    typeof row.state !== "string"
  )
    throw new Error("Invalid queued message response");
  return {
    id: row.id,
    client_id: text(row.client_id),
    kind: text(row.kind),
    content: row.content,
    target: text(row.target),
    revision: number(row.revision),
    state: row.state,
    attachments: objects(row.attachments),
    created_at: text(row.created_at),
  };
}

export function parseExecution(value: unknown): ExecutionState {
  const row = parseObject(value, "Invalid execution response");
  if (
    !Array.isArray(row.requests) ||
    !Array.isArray(row.attempts) ||
    !Array.isArray(row.evidence) ||
    !Array.isArray(row.consultations)
  )
    throw new Error("Incomplete execution response");
  return {
    lead_agent_id: text(row.lead_agent_id),
    plan_revision: number(row.plan_revision, 1),
    engineering_workflow: engineeringWorkflow(row.engineering_workflow),
    execution_mode: text(row.execution_mode, "unknown"),
    requests: objects(row.requests).map(parseExecutionRequest),
    attempts: objects(row.attempts).map((attempt) => {
      const assignment = parseObject(
        attempt.assignment ?? {},
        "Invalid execution response",
      );
      return {
        id: text(attempt.id),
        agent_id: text(attempt.agent_id),
        revision: number(attempt.revision),
        state: text(attempt.state),
        provider: text(assignment.provider),
        model: text(assignment.model, "Not recorded"),
        effort: text(assignment.effort, "default"),
        workflow: text(assignment.workflow),
        result: parseObject(attempt.result ?? {}, "Invalid execution response"),
      };
    }),
    evidence: objects(row.evidence).map((item) => {
      const record = parseObject(
        item.record ?? item,
        "Invalid execution response",
      );
      const check = parseObject(
        record.check ?? {},
        "Invalid execution response",
      );
      const validity = parseObject(
        item.validity ?? {},
        "Invalid execution response",
      );
      const reasons = Array.isArray(validity.reasons)
        ? validity.reasons.map((reason) => text(reason)).join("; ")
        : "";
      return {
        id: text(item.id, text(record.id)),
        attempt_id: text(item.attempt_id),
        revision: number(item.revision, number(record.task_revision)),
        kind: text(check.kind, "Check"),
        result: text(record.status, text(record.result, "unknown")),
        check: text(
          record.command_or_scenario,
          text(
            check.command,
            text(check.scenario, text(check.name, text(record.detail))),
          ),
        ),
        current:
          validity.valid === true
            ? true
            : /revision|manifest|changed|environment|superseded/i.test(reasons)
              ? false
              : typeof item.current === "boolean"
                ? item.current
                : null,
      };
    }),
    checkpoints: objects(row.engineering_checkpoints).map((item) => ({
      revision: number(item.revision),
      step: text(item.step),
      owner: text(item.owner),
      outputs: Object.fromEntries(
        Object.entries(
          parseObject(item.outputs ?? {}, "Invalid execution response"),
        ).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      tool_call_ids: Array.isArray(item.tool_call_ids)
        ? item.tool_call_ids.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
      status: text(item.status, "unknown"),
      unavailable: text(item.unavailable),
    })),
    blockers: Array.isArray(row.engineering_blockers)
      ? row.engineering_blockers.filter(
          (reason): reason is string => typeof reason === "string",
        )
      : [],
    consultations: objects(row.consultations).map((item) => ({
      id: text(item.id),
      state: text(item.state),
      question: text(item.question),
      from_agent: text(item.from_agent, text(item.sender)),
      to_agent: text(item.to_agent, text(item.recipient)),
    })),
  };
}

export const executionKey = (workspace: string, runId: string) => [
  "run-execution",
  workspace,
  runId,
];
export const executionPath = (workspace: string, runId: string) =>
  `/api/v1/w/${encodeURIComponent(workspace)}/runs/${encodeURIComponent(runId)}`;

export function useExecution(workspace: string, runId: string | undefined) {
  return useQuery({
    queryKey: executionKey(workspace, runId ?? ""),
    enabled: !!runId,
    refetchInterval: 2000,
    queryFn: async () =>
      parseExecution(
        await (
          await fetchRaw(`${executionPath(workspace, runId ?? "")}/execution`)
        ).json(),
      ),
  });
}

export async function queueRequest(
  workspace: string,
  runId: string,
  body: {
    content: string;
    attachments: Record<string, string>[];
    client_request_id: string;
    delivery: "queue" | "steer";
  },
) {
  return parseExecutionRequest(
    await (
      await fetchRaw(`${executionPath(workspace, runId)}/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json(),
  );
}

export async function changeRequest(
  workspace: string,
  runId: string,
  id: string,
  action: "steer" | "remove",
) {
  await fetchRaw(
    `${executionPath(workspace, runId)}/requests/${encodeURIComponent(id)}${action === "steer" ? "/steer" : ""}`,
    { method: action === "steer" ? "POST" : "DELETE" },
  );
}

export type RecoveryAction =
  | { requestId: string; action: "retry" | "cancel" }
  | { action: "acknowledge" | "cancel" };
export async function recoverExecution(
  workspace: string,
  runId: string,
  recovery: RecoveryAction,
) {
  const suffix =
    "requestId" in recovery
      ? `/requests/${encodeURIComponent(recovery.requestId)}/recover`
      : "/recovery";
  await fetchRaw(`${executionPath(workspace, runId)}${suffix}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: recovery.action,
      acknowledge_side_effects: true,
    }),
  });
}
