import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApprovalModePicker } from "./ApprovalModePicker";
import { qk } from "@/hooks/queries";
import type { SettingsOut } from "@/types";

const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api,
  unwrap: async (request: Promise<{ data?: unknown }>) => (await request).data,
}));

function renderPicker(approval_mode: "ask" | "auto") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData<SettingsOut>(qk.settings, {
    approval_mode,
  } as SettingsOut);
  render(
    <QueryClientProvider client={queryClient}>
      <ApprovalModePicker />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  api.GET.mockReset();
  api.PUT.mockReset();
});

describe("ApprovalModePicker", () => {
  it.each([
    ["ask", "Ask for permission"],
    ["auto", "Approve for me"],
  ] as const)(
    "shows the saved mode %s and both options",
    async (value, label) => {
      renderPicker(value);
      const user = userEvent.setup();
      const trigger = screen.getByRole("button", {
        name: `Approval mode: ${label}`,
      });
      expect(trigger).toHaveTextContent(label);
      await user.click(trigger);
      expect(
        await screen.findByRole("menuitem", { name: /Ask for permission/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("menuitem", { name: /Approve for me/ }),
      ).toBeInTheDocument();
    },
  );

  it("saves the chosen mode on the server and shows it", async () => {
    api.PUT.mockResolvedValue({ data: { approval_mode: "auto" } });
    api.GET.mockResolvedValue({ data: { approval_mode: "auto" } });
    renderPicker("ask");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Approval mode: Ask for permission" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Approve for me/ }),
    );
    expect(api.PUT).toHaveBeenCalledWith("/api/v1/settings/approval-mode", {
      body: { approval_mode: "auto" },
    });
    expect(
      await screen.findByRole("button", {
        name: "Approval mode: Approve for me",
      }),
    ).toBeInTheDocument();
  });

  it("returns to the saved mode when the server rejects the change", async () => {
    api.PUT.mockRejectedValue(new Error("Backend unavailable"));
    api.GET.mockRejectedValue(new Error("Backend unavailable"));
    const queryClient = renderPicker("ask");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Approval mode: Ask for permission" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: /Approve for me/ }),
    );
    await waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(
      screen.getByRole("button", { name: "Approval mode: Ask for permission" }),
    ).toBeInTheDocument();
  });
});
