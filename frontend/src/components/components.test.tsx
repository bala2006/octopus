import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/overlays";
import { AgentAvatar, StatusPill } from "./common";
import { ApprovalCard } from "@/features/runs/ApprovalCard";
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
