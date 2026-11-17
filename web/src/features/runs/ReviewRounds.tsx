import { Link } from "react-router-dom";
import { ChevronDown, CircleCheck, CircleX, FileCode2 } from "lucide-react";
import { useWorkspaceId } from "@/hooks/queries";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ReviewRound, ReviewRow } from "./runState";

export const SPECIALIST_LABEL: Record<string, string> = {
  reviewer: "Reviewer", security: "Security reviewer", designer: "Designer", verifier: "Verifier", explorer: "Explorer",
};

const SEVERITY_VARIANT = { blocker: "destructive", major: "warning", minor: "outline" } as const;

/** The editor's address for a finding: the file, opened at the first line its lines name. */
export function findingHref(workspace: string, file: string, lines?: string): string {
  const first = Math.max(1, Number.parseInt(lines ?? "", 10) || 1);
  return `/w/${workspace}/workspace?file=${encodeURIComponent(file)}&line=${first}`;
}

/**
 * The review rounds of a conversation, oldest first. Each round is a dropdown that shows its approvals and findings
 * when opened. The newest round opens first.
 */
export function ReviewRounds({ rounds }: { rounds: ReviewRound[] }) {
  if (!rounds.length) return null;
  return (
    <ol aria-label="Review rounds" className="space-y-2 p-3">
      {rounds.map((round, i) => <RoundDropdown key={round.round} round={round} open={i === rounds.length - 1} />)}
    </ol>
  );
}

function RoundDropdown({ round, open }: { round: ReviewRound; open: boolean }) {
  const w = useWorkspaceId();
  const findings = round.specialists.reduce((n, s) => n + s.findings.length, 0);
  const approved = round.specialists.filter((s) => s.verdict === "approve").length;
  return (
    <li>
      <details open={open} data-testid="review-round" className="group rounded-xl bg-card">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <h3 className="text-[13px] font-semibold">Review round {round.round}</h3>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{approved} of {round.specialists.length} approved</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {findings ? `${findings} finding${findings === 1 ? "" : "s"}` : "No findings"}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-2 px-3 pb-3">
          {round.specialists.map((row) => <SpecialistTile key={row.agent_id} row={row} workspace={w} />)}
        </div>
      </details>
    </li>
  );
}

function SpecialistTile({ row, workspace }: { row: ReviewRow; workspace: string }) {
  const approved = row.verdict === "approve";
  const changes = row.verdict === "request_changes";
  const label = approved ? "Approved" : changes ? "Changes requested" : "No verdict";
  return (
    <li className={cn("rounded-lg border-l-2 bg-surface-2 px-3 py-2.5", approved ? "border-success" : changes ? "border-warning" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold">{SPECIALIST_LABEL[row.name] ?? row.name}</h4>
        <Badge variant={approved ? "success" : changes ? "warning" : "outline"}>
          {approved ? <CircleCheck className="h-3 w-3" /> : changes ? <CircleX className="h-3 w-3" /> : null}
          {label}
        </Badge>
      </div>
      {row.findings.length > 0 && (
        <ul className="mt-2.5 divide-y divide-border/60">
          {row.findings.map((f) => (
            <li key={f.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="font-mono text-muted-foreground">{f.id}</span>
                <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                {f.file ? (
                  <Link to={findingHref(workspace, f.file, f.lines)} aria-label={`Open ${f.file}${f.lines ? ` at line ${f.lines}` : ""}`}
                    className="inline-flex items-center gap-1 rounded font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <FileCode2 className="h-3 w-3" aria-hidden="true" />{f.file}{f.lines ? `:${f.lines}` : ""}
                  </Link>
                ) : <span className="text-muted-foreground">the project</span>}
              </div>
              <p className="mt-1.5 text-[13px] leading-5 text-foreground/90">{f.problem}</p>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                <span className="font-medium text-foreground/70">Fix:</span> {f.fix}
              </p>
            </li>
          ))}
        </ul>
      )}
      {row.steps.length > 0 && (
        <details className="group mt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {row.steps.length} tool step{row.steps.length === 1 ? "" : "s"}
            <ChevronDown className={cn("h-3 w-3 transition group-open:rotate-180")} aria-hidden="true" />
          </summary>
          <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3 text-[11px] text-muted-foreground">
            {row.steps.map((s) => <li key={s.id} className={cn("truncate", s.status === "failed" && "text-destructive")}>{s.title}</li>)}
          </ul>
        </details>
      )}
    </li>
  );
}
