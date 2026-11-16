import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ReviewCard, findingHref } from "./ReviewCard";
import type { ReviewRound } from "./runState";

vi.mock("@/hooks/queries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/hooks/queries")>()), useWorkspaceId: () => "w1" }));

const round: ReviewRound = {
  seq: 9, round: 2,
  specialists: [
    { agent_id: "rev", name: "reviewer", verdict: "approve", findings: [], steps: [
      { id: "c1", seq: 3, agent_id: "rev", kind: "read", title: "Read src/cart.ts", detail: "code", status: "ok" },
    ] },
    { agent_id: "sec", name: "security", verdict: "request_changes", findings: [
      { id: "F4", critic: "security", severity: "blocker", file: "src/auth.ts", lines: "12-14", problem: "The token is logged.", evidence: "line 13 prints it", fix: "Remove the log line." },
      { id: "F5", critic: "security", severity: "minor", problem: "The README is out of date.", evidence: "section 2", fix: "Update it." },
    ], steps: [] },
  ],
};

it("shows each specialist's verdict and its findings with severity", () => {
  render(<MemoryRouter><ReviewCard round={round} /></MemoryRouter>);
  const card = screen.getByTestId("review-card");
  expect(within(card).getByRole("heading", { name: /Review round 2/ })).toBeVisible();
  const reviewer = within(card).getByText("Reviewer").closest("li")!;
  expect(within(reviewer).getByText("Approved")).toBeVisible();
  const security = within(card).getByText("Security reviewer").closest("li")!;
  expect(within(security).getByText("Changes requested")).toBeVisible();
  expect(within(security).getByText("blocker")).toBeVisible();
  expect(within(security).getByText("The token is logged.")).toBeVisible();
  expect(within(security).getByText("minor")).toBeVisible();
});

it("links a finding to its file at its first line, and names a finding with no file as the project", () => {
  render(<MemoryRouter><ReviewCard round={round} /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "Open src/auth.ts at line 12-14" });
  expect(link).toHaveAttribute("href", "/w/w1/workspace?file=src%2Fauth.ts&line=12");
  expect(screen.getByText("the project")).toBeVisible();
});

it("folds a specialist's tool steps under its row", () => {
  render(<MemoryRouter><ReviewCard round={round} /></MemoryRouter>);
  const reviewer = screen.getByText("Reviewer").closest("li")!;
  expect(within(reviewer).getByText("1 tool step")).toBeVisible();
  expect(within(reviewer).getByText("Read src/cart.ts")).toBeInTheDocument();
});

it("counts the findings of the whole round", () => {
  render(<MemoryRouter><ReviewCard round={round} /></MemoryRouter>);
  expect(screen.getByText("2 findings")).toBeVisible();
});

it("points a finding without lines at the top of its file", () => {
  expect(findingHref("w1", "README.md")).toBe("/w/w1/workspace?file=README.md&line=1");
});
