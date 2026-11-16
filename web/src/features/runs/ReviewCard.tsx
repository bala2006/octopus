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

/** One review round: a row per specialist with its verdict, its findings with links into the editor, and its tool steps folded. */
export function ReviewCard({ round }: { round: ReviewRound }) {
  const w = useWorkspaceId();
  const count = round.specialists.reduce((n, s) => n + s.findings.length, 0);
  return (
    <section aria-label={`Review round ${round.round}`} data-testid="review-card" className="mx-2 rounded-lg border border-border bg-elevated/60 p-3 text-xs animate-fade-up">
      <h3 className="mb-2 flex items-center gap-2 font-semibold">
        Review round {round.round}
        <span className="font-normal text-muted-foreground">{count ? `${count} finding${count === 1 ? "" : "s"}` : "No findings"}</span>
      </h3>
      <ul className="space-y-2">
        {round.specialists.map((row) => <SpecialistRow key={row.agent_id} row={row} workspace={w} />)}
      </ul>
    </section>
  );
}

function SpecialistRow({ row, workspace }: { row: ReviewRow; workspace: string }) {
  const verdict = row.verdict === "approve" ? "Approved" : row.verdict === "request_changes" ? "Changes requested" : "No verdict";
  return (
    <li className="rounded-md border border-border/70 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{SPECIALIST_LABEL[row.name] ?? row.name}</span>
        <Badge variant={row.verdict === "approve" ? "success" : row.verdict === "request_changes" ? "warning" : "outline"}>
          {row.verdict === "approve" ? <CircleCheck className="h-3 w-3" /> : row.verdict === "request_changes" ? <CircleX className="h-3 w-3" /> : null}
          {verdict}
        </Badge>
      </div>
      {row.findings.length > 0 && (
        <ul className="mt-2 space-y-2">
          {row.findings.map((f) => (
            <li key={f.id} className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] text-muted-foreground">{f.id}</span>
                <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
                {f.file ? (
                  <Link to={findingHref(workspace, f.file, f.lines)} aria-label={`Open ${f.file}${f.lines ? ` at line ${f.lines}` : ""}`}
                    className="inline-flex items-center gap-1 rounded font-mono text-[11px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <FileCode2 className="h-3 w-3" aria-hidden="true" />{f.file}{f.lines ? `:${f.lines}` : ""}
                  </Link>
                ) : <span className="text-[11px] text-muted-foreground">the project</span>}
              </div>
              <p className="leading-snug">{f.problem}</p>
              <p className="text-muted-foreground">Fix: {f.fix}</p>
            </li>
          ))}
        </ul>
      )}
      {row.steps.length > 0 && (
        <details className="group mt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {row.steps.length} tool step{row.steps.length === 1 ? "" : "s"}
            <ChevronDown className={cn("h-3.5 w-3.5 transition group-open:rotate-180")} aria-hidden="true" />
          </summary>
          <ul className="mt-1 space-y-0.5 border-l border-border/60 pl-3 text-muted-foreground">
            {row.steps.map((s) => <li key={s.id} className={cn("truncate", s.status === "failed" && "text-destructive")}>{s.title}</li>)}
          </ul>
        </details>
      )}
    </li>
  );
}
