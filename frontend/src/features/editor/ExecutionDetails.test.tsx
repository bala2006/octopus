import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionDetails } from "./ExecutionDetails";

afterEach(() => vi.unstubAllGlobals());

it("requires review acknowledgement before retrying uncertain work and shows the node failure", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation((_url: string, options?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            options?.method === "POST"
              ? { ok: true }
              : {
                  lead_agent_id: "lead",
                  plan_revision: 2,
                  engineering_workflow: "fix",
                  execution_mode: "trusted_host",
                  requests: [
                    {
                      id: "q",
                      content: "Fix popup",
                      state: "recovery_required",
                    },
                  ],
                  attempts: [
                    {
                      id: "a",
                      agent_id: "engineer",
                      revision: 2,
                      state: "failed",
                      assignment: {
                        provider: "opencode",
                        model: "local/model",
                        effort: "high",
                      },
                      result: {
                        error:
                          "Selected thinking level is not supported by this model",
                      },
                    },
                  ],
                  evidence: [],
                  consultations: [],
                  engineering_checkpoints: [],
                  engineering_blockers: ["Verification required"],
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ExecutionDetails workspace="w" runId="run" agents={{}} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText(
      "Selected thinking level is not supported by this model",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("local/model", { exact: false })).toBeInTheDocument();
  expect(screen.getByText("Verification required")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry message" }));
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "Some effects may already have happened",
  );
  expect(
    fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(0);
  fireEvent.click(
    screen.getByRole("button", { name: "I reviewed effects · Retry" }),
  );
  await waitFor(() =>
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
    ).toHaveLength(1),
  );
  const request = fetcher.mock.calls.find((call) => call[1]?.method === "POST");
  expect(request?.[0]).toBe("/api/v1/w/w/runs/run/requests/q/recover");
  expect(request?.[1]?.body).toBe(
    JSON.stringify({ action: "retry", acknowledge_side_effects: true }),
  );
  client.clear();
});
