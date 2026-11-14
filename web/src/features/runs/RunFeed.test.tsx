import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentOut, MessageOut } from "@/types";
import { RunFeed } from "./RunFeed";
import { initialRun } from "./runState";
import { callStep, finishStep, thoughtStep, type Step } from "./steps";

const fetchRaw = vi.hoisted(() => vi.fn(() => new Promise<Response>(() => undefined)));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), fetchRaw }));
vi.mock("@/hooks/queries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/hooks/queries")>()), useWorkspaceId: () => "w" }));

const agent = (id: string, name: string) => ({ id, name, color: "steel" }) as unknown as AgentOut;
const agents = { riley: agent("riley", "Riley"), ben: agent("ben", "Ben") };
// jsdom has no layout engine, and RunFeed scrolls to the latest item on mount.
Element.prototype.scrollIntoView = () => undefined;

it("groups one agent's consecutive steps under one count line, with its latest thought as the line under it", () => {
  const read = finishStep(callStep(2, { call_id: "c1", agent_id: "riley", tool: "read_file", args: { path: "a.ts" } })!, true, "");
  const steps: Step[] = [
    thoughtStep(1, "riley", "Check the spec first."),
    read,
    thoughtStep(3, "riley", "Now build it."),
    finishStep(callStep(4, { call_id: "c4", agent_id: "riley", tool: "run_command", args: { command: "npm test" } })!, true, ""),
  ];
  render(<RunFeed state={{ ...initialRun(), steps }} agents={agents} filter="all" />);
  const runs = screen.getAllByTestId("step-run");
  expect(runs).toHaveLength(1);
  expect(within(runs[0]).getByText("+ 1 read, 1 command")).toBeVisible();
  expect(within(runs[0]).getByTestId("step-narration")).toHaveTextContent("Now build it.");
});

it("starts a new group when a different agent takes the next step", () => {
  const steps: Step[] = [thoughtStep(1, "riley", "Check the spec first."), thoughtStep(2, "ben", "Looks fine to me.")];
  render(<RunFeed state={{ ...initialRun(), steps }} agents={agents} filter="all" />);
  expect(screen.getAllByTestId("step-run")).toHaveLength(2);
});

const message = (id: string, from: string | null, sender: "user" | "agent", content: string) =>
  ({ id, run_id: "r", sender, from_agent_id: from, to_agent_id: null, type: "task", content, meta: {}, turn_no: 1, created_at: "2026-01-01T10:00:00" }) as unknown as MessageOut;

it("puts the user's messages on the right and each agent's messages on the left, beside its avatar", () => {
  const state = { ...initialRun(), messages: [message("1", "riley", "agent", "Checking the setup."), message("2", null, "user", "continue")] };
  render(<RunFeed state={state} agents={agents} filter="all" />);
  const agentRow = screen.getByText("Checking the setup.").closest("article")!;
  const userRow = screen.getByText("continue").closest("article")!;
  expect(agentRow).toHaveAttribute("data-sender", "agent");
  expect(agentRow.firstElementChild).not.toHaveClass("flex-row-reverse");
  expect(userRow).toHaveAttribute("data-sender", "user");
  expect(userRow.firstElementChild).toHaveClass("flex-row-reverse");
});

it("asks the server for each attached image by the name it was saved under", () => {
  const sent = { ...message("3", null, "user", "see the screenshot"), meta: { images: ["k7-shot.png"] } } as unknown as MessageOut;
  render(<RunFeed state={{ ...initialRun(), messages: [sent] }} agents={agents} filter="all" />);
  expect(fetchRaw).toHaveBeenCalledWith("/api/v1/w/w/runs/r/attachments/k7-shot.png");
});

it("shows one agent's own chat: what it said and was told, and its steps, but not other agents' work", () => {
  const toRiley = { ...message("4", "ben", "agent", "Which colour is the hero?"), to_agent_id: "riley" } as unknown as MessageOut;
  const benToTeam = message("5", "ben", "agent", "Posting to everyone.");
  const steps: Step[] = [thoughtStep(1, "riley", "Reading the brief."), thoughtStep(2, "ben", "Ben is busy.")];
  render(<RunFeed state={{ ...initialRun(), messages: [toRiley, benToTeam], steps }} agents={agents} filter="all" agentId="riley" />);
  expect(screen.getByText("Which colour is the hero?")).toBeVisible();
  expect(screen.queryByText("Posting to everyone.")).toBeNull();
  expect(screen.getAllByTestId("step-run")).toHaveLength(1);
  expect(screen.getByTestId("step-narration")).toHaveTextContent("Reading the brief.");
});

it("opens an agent's chat from its name when the host offers it", async () => {
  const open = vi.fn();
  const { AgentChatContext } = await import("./RunFeed");
  render(<AgentChatContext.Provider value={open}><RunFeed state={{ ...initialRun(), messages: [message("6", "riley", "agent", "Done.")] }} agents={agents} filter="all" /></AgentChatContext.Provider>);
  screen.getByRole("button", { name: "Riley" }).click();
  expect(open).toHaveBeenCalledWith("riley");
});