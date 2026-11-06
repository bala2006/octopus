import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScopedMemoryPanel } from "./ScopedMemoryPanel";

afterEach(() => vi.unstubAllGlobals());
it("fetches the full original before editing and requires explicit sharing with named members", async () => {
  const note = {
    id: "m1",
    key: "Preference",
    version: 2,
    scope: "agent",
    scope_id: "ben",
    run_id: null,
    content: "Full original fact",
    classification: "proposed",
    pinned: false,
    source_refs: [{ kind: "message", id: "msg1" }],
  };
  const writes: unknown[] = [];
  const fetcher = vi
    .fn()
    .mockImplementation((url: string, options?: RequestInit) => {
      let result: unknown = [];
      if (options?.method === "PUT") {
        writes.push(
          JSON.parse(typeof options.body === "string" ? options.body : "{}"),
        );
        result = {
          ...note,
          id: "shared",
          scope: "group",
          scope_id: "pair",
          version: 1,
        };
      } else if (url.includes("/groups?"))
        result = [
          {
            id: "pair",
            name: "Builders",
            members: ["ben", "cy"],
            active: true,
          },
        ];
      else if (url.includes("/sources/message/msg1?"))
        result = {
          id: "msg1",
          content: "Original source text",
          label: "message",
          truncated: false,
        };
      else if (url.includes("/m1?")) result = note;
      else result = [{ ...note, content: "Truncated preview" }];
      return Promise.resolve(
        new Response(JSON.stringify(result), { status: 200 }),
      );
    });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ScopedMemoryPanel
        workspace="w"
        companyId="co"
        agentId="ben"
        agents={[
          { id: "ben", name: "Ben" },
          { id: "cy", name: "Cy" },
        ]}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  expect(await screen.findByText("Truncated preview")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "message:msg1" }));
  expect(await screen.findByText("Original source text")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Review / edit" }));
  expect(await screen.findByLabelText("Memory note")).toHaveValue(
    "Full original fact",
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Share memory with group" }),
    { target: { value: "pair" } },
  );
  expect(screen.getByRole("button", { name: "Share copy" })).toBeDisabled();
  expect(
    screen.getByText(/Share this note and its source with Ben, Cy/),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Confirm sharing memory" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Share copy" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({
    scope: "group",
    scope_id: "pair",
    run_id: null,
    key: "Preference",
    content: "Full original fact",
    expected_version: 0,
    classification: "proposed",
    pinned: false,
    sources: [{ kind: "memory", id: "m1" }],
    share_sources: true,
  });
  client.clear();
});
