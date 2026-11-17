import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "@octopus/shared";
import type { ReviewRound, ReviewRow } from "./runState";
import { summarizeRound, verdictCopy } from "./reviewSummary";

const finding = (id: string, severity: ReviewFinding["severity"]): ReviewFinding => ({ id, critic: "reviewer", severity, problem: "p", evidence: "e", fix: "f" });
const row = (name: string, verdict: ReviewRow["verdict"], findings: ReviewFinding[] = []): ReviewRow => ({ agent_id: name, name, verdict, findings, steps: [] });
const round = (n: number, specialists: ReviewRow[]): ReviewRound => ({ seq: n, round: n, specialists });

describe("summarizeRound", () => {
  it("counts approvals, requests for changes, and findings by severity", () => {
    const s = summarizeRound(round(2, [
      row("reviewer", "approve", [finding("F1", "minor")]),
      row("security", "request_changes", [finding("F2", "blocker"), finding("F3", "major")]),
      row("designer", null),
    ]));

    expect(s).toMatchObject({ approved: 1, requested: 1, findings: 3, bySeverity: { blocker: 1, major: 1, minor: 1 }, worst: "blocker", status: "changes" });
  });

  it("is approved only when every specialist approved, even with findings to read", () => {
    const s = summarizeRound(round(1, [row("reviewer", "approve", [finding("F1", "minor")]), row("security", "approve")]));
    expect(s).toMatchObject({ status: "approved", approved: 2, worst: "minor" });
  });

  it("is waiting while a specialist has no verdict and nobody asked for changes", () => {
    expect(summarizeRound(round(3, [row("reviewer", "approve"), row("designer", null)])).status).toBe("waiting");
  });

  it("has no worst severity when the round has no findings", () => {
    expect(summarizeRound(round(1, [row("reviewer", "approve")])).worst).toBeNull();
  });
});

describe("verdictCopy", () => {
  it("says every specialist approved, and how many findings to read", () => {
    expect(verdictCopy(summarizeRound(round(1, [row("reviewer", "approve", [finding("F1", "minor"), finding("F2", "minor")])])))).toEqual({
      tone: "success", title: "Approved", detail: "Every specialist approved round 1, with 2 findings to read.",
    });
    expect(verdictCopy(summarizeRound(round(4, [row("reviewer", "approve")]))).detail).toBe("Every specialist approved round 4, with no findings.");
  });

  it("counts the specialists who asked for changes", () => {
    expect(verdictCopy(summarizeRound(round(2, [row("reviewer", "request_changes"), row("security", "approve")])))).toEqual({
      tone: "warning", title: "Changes requested", detail: "1 of 2 specialists asked for changes in round 2.",
    });
  });

  it("counts the specialists still without a verdict", () => {
    expect(verdictCopy(summarizeRound(round(3, [row("reviewer", "approve"), row("designer", null), row("security", null)])))).toEqual({
      tone: "muted", title: "Waiting for verdicts", detail: "2 of 3 specialists have not given a verdict in round 3.",
    });
  });
});
