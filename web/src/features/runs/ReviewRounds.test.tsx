import { fireEvent, render, screen, within } from "@testing-library/react";
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

const waiting: ReviewRound = {
  seq: 12, round: 3,
  specialists: [
    { agent_id: "rev", name: "reviewer", verdict: "approve", findings: [], steps: [] },
    { agent_id: "des", name: "designer", verdict: null, findings: [], steps: [] },
  ],
};

const renderRounds = (rounds: ReviewRound[]) => render(<MemoryRouter><ReviewRounds rounds={rounds} /></MemoryRouter>);
const report = () => screen.getByTestId("review-report");

it("lists every round on the rail with its approvals and findings", () => {
  renderRounds([first, second]);
  const [one, two] = screen.getAllByTestId("review-round");
  expect(within(one!).getByText("1 of 1 approved")).toBeInTheDocument();
  expect(within(one!).getByText("No findings")).toBeInTheDocument();
  expect(within(two!).getByText("1 of 2 approved")).toBeInTheDocument();
  expect(within(two!).getByText("2 findings")).toBeInTheDocument();
});

it("headlines the latest round's verdict and says how many asked for changes", () => {
  renderRounds([first, second]);
  const verdict = screen.getByTestId("review-verdict");
  expect(within(verdict).getByRole("heading", { name: "Changes requested" })).toBeInTheDocument();
  expect(within(verdict).getByText("1 of 2 specialists asked for changes in round 2.")).toBeInTheDocument();
  expect(within(verdict).getByText("Findings").nextElementSibling).toHaveTextContent("2");
});

it("opens the newest round first", () => {
  renderRounds([first, second]);
  expect(within(report()).getByRole("heading", { name: "1 of 2 approved" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Round 2/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Round 1/ })).toHaveAttribute("aria-pressed", "false");
});

it("switches the report when another round is picked", () => {
  renderRounds([first, second]);
  fireEvent.click(screen.getByRole("button", { name: /Round 1/ }));
  expect(within(report()).getByRole("heading", { name: "1 of 1 approved" })).toBeInTheDocument();
  expect(within(report()).queryByText("The token is logged.")).toBeNull();
  expect(screen.getByRole("button", { name: /Round 1/ })).toHaveAttribute("aria-pressed", "true");
});

it("shows each specialist's verdict and findings, and links each file to its first line", () => {
  renderRounds([second]);
  const security = screen.getByText("Security reviewer").closest("li")!;
  expect(within(security).getByText("Changes requested")).toBeVisible();
  expect(within(security).getByText("The token is logged.")).toBeVisible();
  expect(within(security).getByText("line 13 prints it")).toBeVisible();
  expect(screen.getByRole("link", { name: "Open src/auth.ts at line 12-14" })).toHaveAttribute("href", "/w/w1/workspace?file=src%2Fauth.ts&line=12");
  expect(within(security).getByText("the project")).toBeVisible();
});

it("folds a specialist's tool steps under its card", () => {
  renderRounds([second]);
  const reviewer = screen.getByText("Reviewer").closest("li")!;
  expect(within(reviewer).getByText("1 tool step")).toBeVisible();
  expect(within(reviewer).getByText("Read src/cart.ts")).toBeInTheDocument();
});

it("says the round is waiting while a specialist has not given a verdict", () => {
  renderRounds([first, waiting]);
  const verdict = screen.getByTestId("review-verdict");
  expect(within(verdict).getByRole("heading", { name: "Waiting for verdicts" })).toBeInTheDocument();
  expect(within(verdict).getByText("1 of 2 specialists have not given a verdict in round 3.")).toBeInTheDocument();
  expect(within(report()).getByText("No verdict yet.")).toBeInTheDocument();
});

it("shows nothing before the first review round", () => {
  const { container } = render(<ReviewRounds rounds={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it("points a finding without lines at the top of its file", () => {
  expect(findingHref("w1", "README.md")).toBe("/w/w1/workspace?file=README.md&line=1");
});
