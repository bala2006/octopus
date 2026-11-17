/**
 * What the Review tab says about a review round, worked out from the round's data. Pure, so the counts and the
 * wording are tested without rendering.
 */
import type { ReviewFinding } from "@octopus/shared";
import type { ReviewRound, ReviewRow } from "./runState";

export type Severity = ReviewFinding["severity"];
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];

/** The colour family a verdict, a status, or a severity uses. */
export type Tone = "success" | "warning" | "muted";

/**
 * A round's outcome. One request for changes makes the round "changes". Otherwise it is "approved" only when every
 * specialist approved. Anything else, such as a specialist that ended without a verdict, is still "waiting".
 */
export type RoundStatus = "approved" | "changes" | "waiting";

export interface RoundSummary {
  round: number;
  members: { name: string; verdict: ReviewRow["verdict"] }[];
  approved: number;
  requested: number;
  findings: number;
  bySeverity: Record<Severity, number>;
  /** The most serious severity in the round, or null when the round has no findings. */
  worst: Severity | null;
  status: RoundStatus;
}

export function summarizeRound(round: ReviewRound): RoundSummary {
  const bySeverity: Record<Severity, number> = { blocker: 0, major: 0, minor: 0 };
  let findings = 0;
  for (const row of round.specialists) {
    for (const finding of row.findings) {
      bySeverity[finding.severity] += 1;
      findings += 1;
    }
  }
  const members = round.specialists.map((row) => ({ name: row.name, verdict: row.verdict }));
  const approved = members.filter((m) => m.verdict === "approve").length;
  const requested = members.filter((m) => m.verdict === "request_changes").length;
  const status: RoundStatus = requested > 0 ? "changes" : members.length > 0 && approved === members.length ? "approved" : "waiting";
  return {
    round: round.round,
    members,
    approved,
    requested,
    findings,
    bySeverity,
    worst: SEVERITIES.find((s) => bySeverity[s] > 0) ?? null,
    status,
  };
}

export function toneOf(verdict: ReviewRow["verdict"]): Tone {
  if (verdict === "approve") return "success";
  if (verdict === "request_changes") return "warning";
  return "muted";
}

export function verdictLabel(verdict: ReviewRow["verdict"]): string {
  if (verdict === "approve") return "Approved";
  if (verdict === "request_changes") return "Changes requested";
  return "No verdict";
}

export const STATUS_LABEL: Record<RoundStatus, string> = { approved: "Approved", changes: "Changes requested", waiting: "Waiting" };
export const STATUS_TONE: Record<RoundStatus, Tone> = { approved: "success", changes: "warning", waiting: "muted" };

export interface VerdictCopy { tone: Tone; title: string; detail: string }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The headline for the latest round: the verdict a reader needs first. */
export function verdictCopy(s: RoundSummary): VerdictCopy {
  const total = s.members.length;
  if (s.status === "changes") {
    return { tone: "warning", title: "Changes requested", detail: `${s.requested} of ${total} specialists asked for changes in round ${s.round}.` };
  }
  if (s.status === "approved") {
    const notes = s.findings ? `, with ${plural(s.findings, "finding")} to read` : ", with no findings";
    return { tone: "success", title: "Approved", detail: `Every specialist approved round ${s.round}${notes}.` };
  }
  return { tone: "muted", title: "Waiting for verdicts", detail: `${total - s.approved} of ${total} specialists have not given a verdict in round ${s.round}.` };
}
