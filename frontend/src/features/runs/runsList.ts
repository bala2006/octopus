/** Pure helpers behind the Runs page: outcome classification, filtering, sorting and day grouping. */
import type { RunOut } from "@/types";

export type RunFilter = "all" | "live" | "finished" | "problems";
export type RunSort = "newest" | "oldest";
type Variant = "default" | "secondary" | "success" | "warning" | "destructive" | "outline";

export const LIVE_STATES = new Set(["queued", "running", "paused", "awaiting_user"]);

export interface Outcome {
  label: string;
  variant: Variant;
  /** completed with a final report and nothing left open on the board: the only state shown as success */
  verified: boolean;
  /** why a completed run isn't shown as a success */
  caveat?: string;
}

/** "Completed" is green only when the run actually delivered: a final report and no open tasks. */
export function outcomeOf(r: Pick<RunOut, "status" | "outcome">): Outcome {
  const o = r.outcome;
  switch (r.status) {
    case "completed": {
      if (!o) return { label: "Completed", variant: "success", verified: true };
      const caveats = [o.tasks_open ? `${o.tasks_open} task${o.tasks_open === 1 ? "" : "s"} still open` : "",
        !o.final_report ? "no final report" : ""].filter(Boolean);
      return caveats.length ? { label: "Completed", variant: "warning", verified: false, caveat: `Not verified: ${caveats.join(", ")}` }
        : { label: "Completed", variant: "success", verified: true };
    }
    case "incomplete": return { label: "Incomplete", variant: "warning", verified: false };
    case "failed": return { label: "Halted", variant: "destructive", verified: false };
    case "cancelled": return { label: "Stopped", variant: "outline", verified: false };
    case "running": return { label: "Running", variant: "default", verified: false };
    case "paused": return { label: "Paused", variant: "warning", verified: false };
    case "awaiting_user": return { label: "Needs you", variant: "warning", verified: false };
    default: return { label: "Queued", variant: "secondary", verified: false };
  }
}

/** Compact facts about what a run produced, e.g. ["2/10 tasks done", "3 blocked", "9 files", "4 errors"]. */
export function outcomeFacts(r: Pick<RunOut, "outcome">): string[] {
  const o = r.outcome;
  if (!o) return [];
  const facts: string[] = [];
  if (o.tasks_total) facts.push(`${o.tasks_done}/${o.tasks_total} tasks done`);
  if (o.tasks_blocked) facts.push(`${o.tasks_blocked} blocked`);
  facts.push(`${o.files} file${o.files === 1 ? "" : "s"}`);
  if (o.errors) facts.push(`${o.errors} error${o.errors === 1 ? "" : "s"}`);
  return facts;
}

export function matchesFilter(r: Pick<RunOut, "status" | "outcome">, f: RunFilter): boolean {
  if (f === "all") return true;
  if (f === "live") return LIVE_STATES.has(r.status);
  if (f === "finished") return r.status === "completed" || r.status === "incomplete";
  return !LIVE_STATES.has(r.status) && !outcomeOf(r).verified; // problems: anything finished that didn't verifiably deliver
}

export function filterRuns<T extends Pick<RunOut, "status" | "goal" | "created_at" | "outcome">>(runs: T[], f: RunFilter, q: string, sort: RunSort): T[] {
  const needle = q.trim().toLowerCase();
  const out = runs.filter((r) => matchesFilter(r, f) && (!needle || r.goal.toLowerCase().includes(needle)));
  return out.sort((a, b) => (sort === "newest" ? -1 : 1) * (Date.parse(a.created_at + "Z") - Date.parse(b.created_at + "Z")));
}

/** Day buckets in display order: "Today", "Yesterday", then dates. */
export function groupByDay<T extends Pick<RunOut, "created_at">>(runs: T[], now = new Date()): Array<{ day: string; runs: T[] }> {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const today = key(now);
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: Array<{ day: string; runs: T[] }> = [];
  for (const r of runs) {
    const d = new Date(r.created_at + "Z");
    const k = key(d);
    const day = k === today ? "Today" : k === yesterday ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.runs.push(r);
    else groups.push({ day, runs: [r] });
  }
  return groups;
}
