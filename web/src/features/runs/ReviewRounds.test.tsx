import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ReviewRounds, findingHref } from "./ReviewRounds";
import type { ReviewRound } from "./runState";

vi.mock("@/hooks/queries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/hooks/queries")>()), useWorkspaceId: () => "w1" }));

const first: ReviewRound = {
  seq: 3, round: 1,
  specialists: [{ agent_id: "rev", name: "reviewer", verdict: "approve", findings: [], steps: [] }],
};

const second: ReviewRound = {
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

it("lists each round as a dropdown with its approvals and findings count", () => {
  render(<MemoryRouter><ReviewRounds rounds={[first, second]} /></MemoryRouter>);
  const [one, two] = screen.getAllByTestId("review-round");
  expect(within(one!).getByText("1 of 1 approved")).toBeInTheDocument();
  expect(within(one!).getByText("No findings")).toBeInTheDocument();
  expect(within(two!).getByText("1 of 2 approved")).toBeInTheDocument();
  expect(within(two!).getByText("2 findings")).toBeInTheDocument();
});

it("opens only the newest round", () => {
  render(<MemoryRouter><ReviewRounds rounds={[first, second]} /></MemoryRouter>);
  const [one, two] = screen.getAllByTestId("review-round") as HTMLDetailsElement[];
  expect(one!.open).toBe(false);
  expect(two!.open).toBe(true);
});

it("shows a round's verdicts and findings, each finding linked to its file at its first line", () => {
  render(<MemoryRouter><ReviewRounds rounds={[second]} /></MemoryRouter>);
  const security = screen.getByText("Security reviewer").closest("li")!;
  expect(within(security).getByText("Changes requested")).toBeVisible();
  expect(within(security).getByText("The token is logged.")).toBeVisible();
  expect(screen.getByRole("link", { name: "Open src/auth.ts at line 12-14" })).toHaveAttribute("href", "/w/w1/workspace?file=src%2Fauth.ts&line=12");
  expect(screen.getByText("the project")).toBeVisible();
});

it("folds a specialist's tool steps under its tile", () => {
  render(<MemoryRouter><ReviewRounds rounds={[second]} /></MemoryRouter>);
  const reviewer = screen.getByText("Reviewer").closest("li")!;
  expect(within(reviewer).getByText("1 tool step")).toBeVisible();
  expect(within(reviewer).getByText("Read src/cart.ts")).toBeInTheDocument();
});

it("shows nothing before the first review round", () => {
  const { container } = render(<ReviewRounds rounds={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("points a finding without lines at the top of its file", () => {
  expect(findingHref("w1", "README.md")).toBe("/w/w1/workspace?file=README.md&line=1");
});
