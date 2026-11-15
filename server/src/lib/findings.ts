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

/** The text the writer reads for a set of findings. */
export function renderFindings(list: Finding[]): string {
  return list
    .map((f) => `- ${f.id} [${f.severity}]${f.file ? ` ${f.file}${f.lines ? `:${f.lines}` : ""}` : ""}: ${f.problem}\n  Evidence: ${f.evidence}\n  Fix: ${f.fix}`)
    .join("\n");
}
