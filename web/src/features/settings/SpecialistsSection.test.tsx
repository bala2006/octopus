import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { SettingsOut } from "@octopus/shared";
import { SpecialistsSection } from "./SpecialistsSection";
import { qk } from "@/hooks/queries";

const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api", () => ({ api, unwrap: async (request: Promise<{ data?: unknown }>) => (await request).data }));

const specialist = (model: string) => ({ enabled: true, model, effort: "high" as const });
const settings = {
  approval_mode: "ask",
  providers: [{ provider: "azure", label: "Azure OpenAI", configured: true, needs_key: true, needs_base: true, models: ["gpt-6-luna"] }],
  specialists: {
    specialists: { reviewer: specialist("gpt-6-luna"), security: specialist("gpt-6-luna"), designer: specialist("gpt-6-luna"), explorer: specialist("gpt-6-luna"), verifier: specialist("gpt-6-luna") },
    review: { floor: true, floor_rounds: 2, check_blocks: 3, verify_rounds: 2 },
  },
} as unknown as SettingsOut;

beforeEach(() => {
  api.PUT.mockReset();
  api.PUT.mockImplementation(async (_path: string, init: { body: unknown }) => ({ data: init.body }));
});

it("saves every change to the specialists and the review floor in one request", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData<SettingsOut>(qk.settings, settings);
  render(<QueryClientProvider client={queryClient}><SpecialistsSection /></QueryClientProvider>);
  const save = screen.getByRole("button", { name: "Save specialists" });
  expect(save).toBeDisabled();

  const user = userEvent.setup();
  await user.click(screen.getByRole("switch", { name: "Run Security reviewer" }));
  await user.click(screen.getByRole("switch", { name: "Review floor" }));
  await user.click(save);

  await waitFor(() => expect(api.PUT).toHaveBeenCalledTimes(1));
  const [path, init] = api.PUT.mock.calls[0] as [string, { body: SettingsOut["specialists"] }];
  expect(path).toBe("/api/v1/settings/specialists");
  expect(init.body.specialists.security.enabled).toBe(false);
  expect(init.body.specialists.reviewer.enabled).toBe(true);
  expect(init.body.review).toEqual({ floor: false, floor_rounds: 2, check_blocks: 3, verify_rounds: 2 });
  await waitFor(() => expect(save).toBeDisabled());
});
