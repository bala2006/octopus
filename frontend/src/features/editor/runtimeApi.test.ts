import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeRequest,
  parseExecution,
  parseExecutionRequest,
  queueRequest,
  recoverExecution,
} from "./runtimeApi";

afterEach(() => vi.unstubAllGlobals());

describe("execution response", () => {
  it.each([null, [], "not an object", 7])(
    "rejects a non-object execution response: %s",
    (value) => {
      expect(() => parseExecution(value)).toThrow("Invalid execution response");
    },
  );

  it("rejects malformed nested attachments instead of accepting an untyped queued message", () => {
    expect(() =>
      parseExecutionRequest({
        id: "q",
        content: "hello",
        state: "queued",
        attachments: [null],
      }),
    ).toThrow("Invalid execution response");
  });

  it("keeps node models, queued messages, and stale proof tied to their revision", () => {
    const data = parseExecution({
      lead_agent_id: "lead",
      plan_revision: 4,
      engineering_workflow: "fix",
      execution_mode: "trusted_host",
      requests: [
        {
          id: "q1",
          content: "Use orange",
          state: "queued",
          revision: 4,
          attachments: [{ filename: "reference.png" }],
        },
      ],
      attempts: [
        {
          id: "a1",
          agent_id: "frontend",
          revision: 3,
          state: "superseded",
          assignment: {
            provider: "opencode",
            model: "local/model",
            effort: "high",
            workflow: "fix",
          },
          result: {},
        },
      ],
      evidence: [
        {
          id: "e1",
          attempt_id: "a1",
          revision: 3,
          record: {
            status: "pass",
            check: { kind: "ui", scenario: "Open, collapse, restore" },
          },
          validity: { valid: false, reasons: ["Task revision changed"] },
        },
      ],
      consultations: [],
    });
    expect(data.requests[0]).toMatchObject({
      id: "q1",
      content: "Use orange",
      state: "queued",
      revision: 4,
      attachments: [{ filename: "reference.png" }],
    });
    expect(data.attempts[0]).toMatchObject({
      model: "local/model",
      effort: "high",
      state: "superseded",
      revision: 3,
    });
    expect(data.evidence[0]).toMatchObject({
      kind: "ui",
      result: "pass",
      check: "Open, collapse, restore",
      current: false,
    });
    expect(data.engineering_workflow).toBe("fix");
  });

  it("does not call a failed current check stale", () => {
    const state = parseExecution({
      requests: [],
      attempts: [],
      consultations: [],
      evidence: [
        {
          id: "e",
          record: {
            status: "fail",
            check: { kind: "command", command: "npm test" },
          },
          validity: { valid: false, reasons: ["Check failed"] },
        },
      ],
    });
    expect(state.evidence[0]).toMatchObject({
      result: "fail",
      current: null,
      check: "npm test",
    });
  });

  it("rejects invalid accepted-message payloads instead of silently losing them", () => {
    expect(() => parseExecutionRequest({ id: "q1", content: "hello" })).toThrow(
      "Invalid queued message response",
    );
    expect(
      parseExecutionRequest({ id: "q1", content: "hello", state: "queued" }),
    ).toMatchObject({ id: "q1", state: "queued", content: "hello" });
  });

  it("reads flattened evidence and records checkpoints without claiming they passed", () => {
    const data = parseExecution({
      plan_revision: 2,
      requests: [],
      attempts: [],
      consultations: [],
      evidence: [
        {
          id: "e",
          status: "pass",
          check: { kind: "command", command: "npm test" },
          validity: { valid: true, reasons: [] },
        },
      ],
      engineering_checkpoints: [
        {
          revision: 2,
          step: "verify",
          owner: "lead",
          outputs: { command: "npm test" },
          tool_call_ids: ["tool1"],
          status: "recorded",
          unavailable: "",
        },
      ],
      engineering_blockers: ["Independent review required"],
    });
    expect(data.evidence[0]).toMatchObject({
      result: "pass",
      current: true,
      check: "npm test",
    });
    expect(data.checkpoints).toEqual([
      {
        revision: 2,
        step: "verify",
        owner: "lead",
        outputs: { command: "npm test" },
        tool_call_ids: ["tool1"],
        status: "recorded",
        unavailable: "",
      },
    ]);
    expect(data.blockers).toEqual(["Independent review required"]);
  });
});

it("persists the message and idempotency key through the backend request API", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "server-request",
        content: "Fix popup",
        state: "queued",
      }),
      { status: 202 },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = await queueRequest("workspace", "run", {
    content: "Fix popup",
    attachments: [],
    client_request_id: "same-key-on-retry",
    delivery: "queue",
  });
  expect(result.id).toBe("server-request");
  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/v1/w/workspace/runs/run/requests",
  );
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    content: "Fix popup",
    attachments: [],
    client_request_id: "same-key-on-retry",
    delivery: "queue",
  });
});

it("steers and removes the server-owned queued message", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
  vi.stubGlobal("fetch", fetcher);
  await changeRequest("workspace", "run", "message", "steer");
  await changeRequest("workspace", "run", "message", "remove");
  expect(
    fetcher.mock.calls.map(([url, request]) => ({
      url,
      method: request.method,
    })),
  ).toEqual([
    {
      url: "/api/v1/w/workspace/runs/run/requests/message/steer",
      method: "POST",
    },
    { url: "/api/v1/w/workspace/runs/run/requests/message", method: "DELETE" },
  ]);
});

it("sends explicit side-effect acknowledgement for request and execution recovery", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
  vi.stubGlobal("fetch", fetcher);
  await recoverExecution("w", "run", { requestId: "q", action: "retry" });
  await recoverExecution("w", "run", { action: "acknowledge" });
  expect(
    fetcher.mock.calls.map(([url, request]) => ({
      url,
      method: request.method,
      body: JSON.parse(request.body),
    })),
  ).toEqual([
    {
      url: "/api/v1/w/w/runs/run/requests/q/recover",
      method: "POST",
      body: { action: "retry", acknowledge_side_effects: true },
    },
    {
      url: "/api/v1/w/w/runs/run/recovery",
      method: "POST",
      body: { action: "acknowledge", acknowledge_side_effects: true },
    },
  ]);
});
