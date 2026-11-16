/**
 * Structured review findings: what a critic reports, how the writer answers, and what still stops a part from
 * finishing. Pure functions. The engine keeps the list on the run state.
 */

export type Severity = "blocker" | "major" | "minor";
export type FindingStatus = "open" | "fixed" | "disputed" | "resolved";

/** What a critic reports. */
export interface FindingInput {
  severity: Severity;
  file?: string;
  lines?: string;
  problem: string;
  evidence: string;
  fix: string;
}

/** A finding as the engine keeps it: with its id, its critic, and what the writer said about it. */
export interface Finding extends FindingInput {
  id: string;
  critic: string;
  status: FindingStatus;
  response?: string;
}

/** The writer's answer to one finding. */
export interface Answer {
  id: string;
  status: "fixed" | "disputed";
  response: string;
}

/** Why a review cannot be recorded as given, or null. Approve may carry only minor notes. */
export function reviewError(verdict: "approve" | "request_changes", findings: FindingInput[]): string | null {
  const blocking = findings.filter((f) => f.severity !== "minor").length;
  if (verdict === "request_changes" && blocking === 0) {
    return "request_changes needs at least one blocker or major finding. If only minor notes remain, approve.";
  }
  if (verdict === "approve" && blocking > 0) return "approve cannot carry blocker or major findings. Request changes instead.";
  return null;
}

/** Record a critic's findings after those already kept for the part. Ids run F1, F2, ... for the whole part. */
export function addFindings(list: Finding[], critic: string, inputs: FindingInput[]): { list: Finding[]; added: Finding[] } {
  const added = inputs.map((f, i) => ({ ...f, id: `F${list.length + i + 1}`, critic, status: "open" as const }));
  return { list: [...list, ...added], added };
}

/** Once the round that could check a fixed or disputed finding has closed, the finding is settled. */
export function settlePrior(list: Finding[]): Finding[] {
  return list.map((f) => (f.status === "fixed" || f.status === "disputed" ? { ...f, status: "resolved" as const } : f));
}

/** Apply the writer's answers. Ids that match no finding come back so the writer can correct them. */
export function answerFindings(list: Finding[], answers: Answer[]): { list: Finding[]; unknown: string[] } {
  const ids = new Set(list.map((f) => f.id));
  const unknown = answers.map((a) => a.id.trim().toUpperCase()).filter((id) => !ids.has(id));
  const byId = new Map(answers.map((a) => [a.id.trim().toUpperCase(), a]));
  const next = list.map((f) => {
    const a = byId.get(f.id);
    return a && f.status === "open" ? { ...f, status: a.status, response: a.response } : f;
  });
  return { list: next, unknown };
}

/** Open findings that block finishing. Minor notes never block. */
export function blockingOpen(list: Finding[]): Finding[] {
  return list.filter((f) => f.status === "open" && f.severity !== "minor");
}

/**
 * Blocking findings a run cannot count as finished: anything not yet resolved. A fix or a dispute is only resolved once
 * a later review round has checked it, so an answer alone does not settle a blocker.
 */
export function unresolvedBlocking(list: Finding[]): Finding[] {
  return list.filter((f) => f.severity !== "minor" && f.status !== "resolved");
}

/** The text the writer reads for a set of findings. */
export function renderFindings(list: Finding[]): string {
  return list
    .map((f) => `- ${f.id} [${f.severity}]${f.file ? ` ${f.file}${f.lines ? `:${f.lines}` : ""}` : ""}: ${f.problem}\n  Evidence: ${f.evidence}\n  Fix: ${f.fix}`)
    .join("\n");
}

/** A critic's report for one review round: its verdict, or null when it ended without one, and its findings. */
export interface CriticReport { critic: string; verdict: "approve" | "request_changes" | null; findings: FindingInput[] }

/** Where a finding points, as a message shows it. */
export const locate = (f: { file?: string; lines?: string }) => (f.file ? (f.lines ? `${f.file}:${f.lines}` : f.file) : "the project");

/**
 * Numbers the findings of one round, across the critics in the order they report, from `first`. The ids of a request
 * run on across its rounds, so a finding keeps its number when the review is asked again.
 */
export function numberFindings(reports: CriticReport[], first: number): Finding[] {
  const out: Finding[] = [];
  for (const r of reports) for (const f of r.findings) out.push({ ...f, id: `F${first + out.length}`, critic: r.critic, status: "open" });
  return out;
}

/** A message that keeps a head and whole items in order. Items past the limit are dropped, and the message says how many findings were dropped. */
function fit(head: string, items: { text: string; counted: boolean }[], limit: number): string {
  const whole = head + items.map((i) => i.text).join("");
  if (whole.length <= limit) return whole;
  const CUT_NOTE = 110;
  let text = head;
  let dropped = 0;
  let stopped = false;
  for (const item of items) {
    if (!stopped && text.length + item.text.length + CUT_NOTE <= limit) {
      text += item.text;
      continue;
    }
    stopped = true;
    if (item.counted) dropped++;
  }
  return `${text}\n\n(${dropped} more findings did not fit in one message. Run review again to see them.)`;
}

/**
 * The one message a review round returns to the main agent, in the plan's findings format. Findings are numbered from
 * `first` across critics in the order they report. Blockers and majors come first, to be answered. Minor findings are
 * listed, not sent back.
 */
export function reviewReport(round: number, reports: CriticReport[], limit: number, first = 1): string {
  const list = numberFindings(reports, first);
  const verdicts = reports.map((r) => `${r.critic}: ${r.verdict === null ? "no verdict" : r.verdict === "approve" ? "approve" : "request changes"}`);
  const blocking = list.filter((f) => f.severity !== "minor");
  const minor = list.filter((f) => f.severity === "minor");
  const head = `Review of your change, round ${round}. ${verdicts.join(". ")}.\n${blocking.length ? "Answer each blocker and major: fix it, or say in one sentence why it is wrong." : "No blocker or major finding."}`;
  const items = [
    ...blocking.map((f) => ({ text: `\n\n${f.id} ${f.severity} ${locate(f)} (${f.critic})\nProblem: ${f.problem}\nEvidence: ${f.evidence}\nFix: ${f.fix}`, counted: true })),
    ...minor.map((f, i) => ({ text: `${i === 0 ? "\n\nMinor, not sent back:" : ""}\n${f.id} ${locate(f)} (${f.critic}) ${f.problem}`, counted: true })),
  ];
  return fit(head, items, limit);
}

/** The open items a reply lists: one line per finding, with its id, severity, place, critic and problem. */
export function renderOpenItems(list: Finding[]): string {
  if (!list.length) return "";
  return ["Open items:", ...list.map((f) => `- ${f.id} ${f.severity} ${locate(f)} (${f.critic}): ${f.problem}`)].join("\n");
}
