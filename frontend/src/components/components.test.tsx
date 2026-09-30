import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/overlays";
import { AgentAvatar, StatusPill } from "./common";
import { ApprovalCard } from "@/features/runs/ApprovalCard";
import { QuestionCard } from "@/features/runs/QuestionCard";
import { lineDiff, diffStats } from "@/lib/diff";

const wrap = (ui: React.ReactNode) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe("components", () => {
  it("StatusPill shows live activity text", () => {
    wrap(<StatusPill status="writing" activity="Writing backend/app.py…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Writing backend/app.py…");
  });

  it("AgentAvatar exposes status label", () => {
    wrap(<AgentAvatar name="Ava" color="#f59e0b" status="thinking" />);
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("ApprovalCard shows a diff and approves with scope", () => {
    const onDecide = vi.fn();
    wrap(<ApprovalCard onDecide={onDecide} approval={{ id: "1", agent_id: "a", kind: "write_file", summary: "Priya wants to modify docs/PRD.md", preview: "",
      details: { path: "docs/PRD.md", old: "a\nb\n", new: "a\nc\n" } }} />);
    expect(screen.getByText("+1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(onDecide).toHaveBeenCalledWith(true, "always", "");
  });

  it("lineDiff computes additions and removals", () => {
    const d = lineDiff("x\ny\nz", "x\nY\nz\nw");
    expect(diffStats(d)).toEqual({ added: 2, removed: 1 });
  });
});

describe("QuestionCard", () => {
  const awaiting = {
    agent_id: "a", question: "Which database should we use?",
    options: [{ label: "SQLite", description: "zero setup" }, { label: "Postgres", description: "scales", recommended: true }, { label: "MySQL" }],
  };

  it("pre-selects the recommended answer and sends it", () => {
    const onAnswer = vi.fn();
    wrap(<QuestionCard awaiting={awaiting} onAnswer={onAnswer} />);
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Postgres/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(onAnswer).toHaveBeenCalledWith("Postgres (scales)");
  });

  it("number keys pick an option; 'Something else' accepts a typed answer", () => {
    const onAnswer = vi.fn();
    wrap(<QuestionCard awaiting={awaiting} onAnswer={onAnswer} />);
    fireEvent.keyDown(screen.getByRole("group"), { key: "1" });
    expect(screen.getByRole("radio", { name: /SQLite/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /Something else/ }));
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "DuckDB" } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(onAnswer).toHaveBeenCalledWith("DuckDB");
  });
});
