import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/overlays";
import ArtifactsPage from "./ArtifactsPage";

vi.mock("@/lib/monaco", () => ({}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { GET: async (_path: string, options: { params: { query: { version: number } } }) => ({
    data: { content: options.params.query.version === 2 ? "" : options.params.query.version === 1 ? "Saved content\n" : "Original content\n" },
    response: new Response(null, { status: 200 }),
  }) } };
});
vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => <pre>{value}</pre>,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => <div><pre data-testid="original">{original}</pre><pre data-testid="modified">{modified}</pre></div>,
}));
vi.mock("@/hooks/queries", () => ({
  useWorkspaceId: () => "w",
  useCompanyId: () => ({ companyId: "company" }),
  useRuns: () => ({ data: [{ id: "run", goal: "Remove old file", status: "completed", created_at: "2026-01-01" }] }),
  useRun: () => ({ data: { snapshot: { agents: [] } } }),
  useArtifacts: () => ({ data: [
    { id: "v1", path: "old.md", version: 1, size: 14, created_at: "2026-01-01", deleted: false },
    { id: "v2", path: "old.md", version: 2, size: 0, created_at: "2026-01-02", deleted: true },
  ] }),
  qk: { files: (workspace: string) => ["files", workspace] },
}));

afterEach(() => vi.unstubAllGlobals());

it("shows deletion history and removed content while preventing a missing-file preview", async () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider><MemoryRouter initialEntries={["/w/w/artifacts/run"]}><Routes><Route path="/w/:workspace/artifacts/:runId" element={<ArtifactsPage />} /></Routes></MemoryRouter></TooltipProvider>
  </QueryClientProvider>);
  expect(await screen.findByText("File deleted")).toBeVisible();
  expect(screen.getAllByText("Deleted")).toHaveLength(3);
  expect(screen.getByRole("tab", { name: "Preview" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Edit current file" })).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Diff" }));
  await waitFor(() => expect(screen.getByTestId("original")).toHaveTextContent("Saved content"));
  expect(screen.getByTestId("modified")).toBeEmptyDOMElement();
  await user.click(screen.getByRole("button", { name: /Agent.*v1/ }));
  await waitFor(() => expect(screen.getByTestId("modified")).toHaveTextContent("Saved content"));
  expect(screen.getByRole("tab", { name: "Preview" })).toBeEnabled();
});
