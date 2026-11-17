import * as React from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, CircleCheck, CircleX, FileCode2, Minus, X } from "lucide-react";
import type { ReviewFinding } from "@octopus/shared";
import { useWorkspaceId } from "@/hooks/queries";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ReviewRound, ReviewRow } from "./runState";
import {
  SEVERITIES, STATUS_LABEL, STATUS_TONE, summarizeRound, toneOf, verdictCopy, verdictLabel,
  type RoundStatus, type RoundSummary, type Severity, type Tone,
} from "./reviewSummary";

const SPECIALIST_LABEL: Record<string, string> = {
  reviewer: "Reviewer", security: "Security reviewer", designer: "Designer", verifier: "Verifier", explorer: "Explorer",
};

const TONE: Record<Tone, { text: string; bg: string; border: string; stroke: string }> = {
  success: { text: "text-success", bg: "bg-success/15", border: "border-success/40", stroke: "stroke-success" },
  warning: { text: "text-warning", bg: "bg-warning/15", border: "border-warning/40", stroke: "stroke-warning" },
  muted: { text: "text-muted-foreground", bg: "bg-muted", border: "border-border", stroke: "stroke-muted-foreground" },
};

const SEVERITY_FILL: Record<Severity, string> = { blocker: "bg-destructive", major: "bg-warning", minor: "bg-muted-foreground/60" };
const SEVERITY_VARIANT = { blocker: "destructive", major: "warning", minor: "outline" } as const;

/** The editor's address for a finding: the file, opened at the first line its lines name. */
export function findingHref(workspace: string, file: string, lines?: string): string {
  const first = Math.max(1, Number.parseInt(lines ?? "", 10) || 1);
  return `/w/${workspace}/workspace?file=${encodeURIComponent(file)}&line=${first}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The Review tab. A verdict card names the latest round's outcome. A rail below it lists every round as a card, with
 * each specialist's verdict and the round's finding count on a bar that shrinks as the work converges. The selected
 * round's report follows: one card per specialist, with its findings. The newest round is selected first.
 */
export function ReviewRounds({ rounds }: { rounds: ReviewRound[] }) {
  const [picked, setPicked] = React.useState<number | null>(null);
  const workspace = useWorkspaceId();
  if (!rounds.length) return null;

  const summaries = rounds.map(summarizeRound);
  const latest = summaries[summaries.length - 1]!;
  const pickedIndex = rounds.findIndex((r) => r.round === picked);
  const shownIndex = pickedIndex >= 0 ? pickedIndex : rounds.length - 1;

  return (
    <div className="space-y-5 p-4" data-testid="review-rounds">
      <VerdictCard latest={latest} summaries={summaries} />
      <RoundRail summaries={summaries} selected={summaries[shownIndex]!.round} onPick={setPicked} />
      <RoundReport key={rounds[shownIndex]!.round} round={rounds[shownIndex]!} summary={summaries[shownIndex]!} workspace={workspace} />
    </div>
  );
}

function VerdictCard({ latest, summaries }: { latest: RoundSummary; summaries: RoundSummary[] }) {
  const copy = verdictCopy(latest);
  const findings = summaries.reduce((n, s) => n + s.findings, 0);
  return (
    <section aria-labelledby="review-verdict" data-testid="review-verdict"
      className={cn("flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border bg-card p-5", TONE[copy.tone].border)}>
      <ApprovalRing approved={latest.approved} total={latest.members.length} tone={copy.tone} />
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Latest verdict, round {latest.round}</p>
        <h2 id="review-verdict" className={cn("mt-0.5 text-xl font-semibold", TONE[copy.tone].text)}>{copy.title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{copy.detail}</p>
      </div>
      <dl className="flex gap-6">
        <Stat label="Rounds" value={summaries.length} />
        <Stat label="Findings" value={findings} />
      </dl>
    </section>
  );
}

/** A ring that fills as specialists approve the latest round. */
function ApprovalRing({ approved, total, tone }: { approved: number; total: number; tone: Tone }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const share = total ? approved / total : 0;
  return (
    <div role="img" aria-label={`${approved} of ${total} approved`} className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox="0 0 56 56" aria-hidden="true" className="absolute inset-0 h-full w-full -rotate-90">
        <circle cx="28" cy="28" r={radius} fill="none" strokeWidth="5" className="stroke-muted" />
        <circle cx="28" cy="28" r={radius} fill="none" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={`${circumference * share} ${circumference}`} className={cn("transition-[stroke-dasharray] duration-700", TONE[tone].stroke)} />
      </svg>
      <span className="text-sm font-semibold tabular-nums">
        {approved}<span className="text-muted-foreground">/{total}</span>
      </span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function RoundRail({ summaries, selected, onPick }: { summaries: RoundSummary[]; selected: number; onPick: (round: number) => void }) {
  const most = Math.max(1, ...summaries.map((s) => s.findings));
  return (
    <nav aria-label="Review rounds" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol className="flex items-center">
        {summaries.map((s, i) => (
          <li key={s.round} className="flex items-center">
            <button type="button" aria-pressed={s.round === selected} onClick={() => onPick(s.round)} data-testid="review-round"
              className={cn("w-60 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                s.round === selected ? "border-primary/60 ring-1 ring-primary/30" : "border-border")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold">Round {s.round}</span>
                <StatusPill status={s.status} />
              </div>
              <div className="mt-3 flex items-center gap-1.5">
                {s.members.map((m, j) => <VerdictDot key={j} name={m.name} verdict={m.verdict} />)}
                <span className="ml-1 text-[11px] tabular-nums text-muted-foreground">{s.approved} of {s.members.length} approved</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div className={cn("h-full rounded-full transition-[width] duration-500", s.worst ? SEVERITY_FILL[s.worst] : "bg-success")}
                    style={{ width: `${s.findings ? Math.max(10, (s.findings / most) * 100) : 0}%` }} />
                </div>
                <span className={cn("w-20 text-right text-[11px] tabular-nums", s.findings ? "text-muted-foreground" : "text-success")}>
                  {s.findings ? plural(s.findings, "finding") : "No findings"}
                </span>
              </div>
            </button>
            {i < summaries.length - 1 && <span aria-hidden="true" className="mx-2 h-px w-6 shrink-0 bg-border" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function StatusPill({ status }: { status: RoundStatus }) {
  const tone = STATUS_TONE[status];
  return <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", TONE[tone].bg, TONE[tone].text)}>{STATUS_LABEL[status]}</span>;
}

function VerdictDot({ name, verdict }: { name: string; verdict: ReviewRow["verdict"] }) {
  const tone = toneOf(verdict);
  const Icon = verdict === "approve" ? Check : verdict === "request_changes" ? X : Minus;
  return (
    <span title={`${SPECIALIST_LABEL[name] ?? name}: ${verdictLabel(verdict)}`} className={cn("flex h-5 w-5 items-center justify-center rounded-full", TONE[tone].bg, TONE[tone].text)}>
      <Icon className="h-3 w-3" aria-hidden="true" />
    </span>
  );
}

function RoundReport({ round, summary, workspace }: { round: ReviewRound; summary: RoundSummary; workspace: string }) {
  const present = SEVERITIES.filter((s) => summary.bySeverity[s] > 0);
  return (
    <section aria-label={`Round ${round.round} report`} data-testid="review-report" className="animate-fade-up space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Round {round.round}</p>
          <h3 className="text-base font-semibold">{summary.approved} of {summary.members.length} approved</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {present.length ? present.map((s) => (
            <Badge key={s} variant={SEVERITY_VARIANT[s]}>{summary.bySeverity[s]} {s}</Badge>
          )) : (
            <Badge variant="success"><CircleCheck className="h-3 w-3" aria-hidden="true" />No findings</Badge>
          )}
        </div>
      </header>
      <ul className="grid gap-3 min-[640px]:grid-cols-2">
        {round.specialists.map((row) => <SpecialistCard key={row.agent_id} row={row} workspace={workspace} />)}
      </ul>
    </section>
  );
}

function SpecialistCard({ row, workspace }: { row: ReviewRow; workspace: string }) {
  const tone = toneOf(row.verdict);
  const label = SPECIALIST_LABEL[row.name] ?? row.name;
  return (
    <li data-testid="review-specialist" className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card", TONE[tone].border)}>
      <div className="flex items-center gap-3 p-3.5">
        <span aria-hidden="true" className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold", TONE[tone].bg, TONE[tone].text)}>
          {label.charAt(0)}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-[13px] font-semibold">{label}</h4>
        </div>
        <VerdictChip verdict={row.verdict} />
      </div>
      <div className="flex-1 border-t border-border/60 px-3.5 py-3">
        {row.findings.length ? (
          <ul className="space-y-4">
            {row.findings.map((f) => <FindingItem key={f.id} finding={f} workspace={workspace} />)}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            {row.verdict ? <><Check className="h-3 w-3" aria-hidden="true" />No findings.</> : "No verdict yet."}
          </p>
        )}
      </div>
      {row.steps.length > 0 && <StepsDisclosure row={row} />}
    </li>
  );
}

function VerdictChip({ verdict }: { verdict: ReviewRow["verdict"] }) {
  const tone = toneOf(verdict);
  const Icon = verdict === "approve" ? CircleCheck : verdict === "request_changes" ? CircleX : null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", TONE[tone].border, TONE[tone].text)}>
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {verdictLabel(verdict)}
    </span>
  );
}

function FindingItem({ finding: f, workspace }: { finding: ReviewFinding; workspace: string }) {
  return (
    <li className="grid grid-cols-[3px_minmax(0,1fr)] gap-x-3">
      <span aria-hidden="true" className={cn("rounded-full", SEVERITY_FILL[f.severity])} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          <span className="font-mono text-muted-foreground">{f.id}</span>
          <Badge variant={SEVERITY_VARIANT[f.severity]}>{f.severity}</Badge>
          {f.file ? (
            <Link to={findingHref(workspace, f.file, f.lines)} aria-label={`Open ${f.file}${f.lines ? ` at line ${f.lines}` : ""}`}
              className="inline-flex min-w-0 items-center gap-1 rounded font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <FileCode2 className="h-3 w-3 shrink-0" aria-hidden="true" /><span className="truncate">{f.file}{f.lines ? `:${f.lines}` : ""}</span>
            </Link>
          ) : <span className="text-muted-foreground">the project</span>}
        </div>
        <p className="mt-1.5 text-[13px] leading-5 text-foreground/90">{f.problem}</p>
        {f.evidence && <p className="mt-1 border-l-2 border-border pl-2 text-[12px] leading-5 text-muted-foreground">{f.evidence}</p>}
        <p className="mt-1.5 text-[12px] leading-5 text-muted-foreground">
          <span className="font-medium text-foreground/70">Fix:</span> {f.fix}
        </p>
      </div>
    </li>
  );
}

function StepsDisclosure({ row }: { row: ReviewRow }) {
  return (
    <details className="group border-t border-border/60 px-3.5 py-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {plural(row.steps.length, "tool step")}
        <ChevronDown className="h-3 w-3 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-l border-border/60 pl-3 text-[11px] text-muted-foreground">
        {row.steps.map((s) => <li key={s.id} className={cn("truncate", s.status === "failed" && "text-destructive")}>{s.title}</li>)}
      </ul>
    </details>
  );
}
