import * as React from "react";
import { Link } from "react-router-dom";
import { BookOpen, Check, ChevronDown, X } from "lucide-react";
import { useCompanies, useRuns, useSettings, useWorkspaceId } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import { useApp } from "@/stores/app";

interface Step { title: string; hint: string; done: boolean; optional?: boolean; action?: React.ReactNode }

/** Small, dismissible checklist that walks a new user through the five things that matter. */
export function GettingStarted({ onRun }: { onRun?: () => void }) {
  const w = useWorkspaceId();
  const { onboarded, setOnboarded } = useApp();
  const [open, setOpen] = React.useState<boolean | null>(null); // null = decide from progress
  const companies = useCompanies(w);
  const runs = useRuns(w);
  const settings = useSettings();
  if (onboarded || companies.isLoading || runs.isLoading) return null;

  const modelReady = !!settings.data?.providers.some((p) => p.provider !== "mock" && p.configured);
  const hasRun = !!runs.data?.length;
  const finished = !!runs.data?.some((r) => r.status === "completed");
  const steps: Step[] = [
    { title: "Open a project folder", hint: "Agents only work inside it.", done: true },
    { title: "Create a team", hint: "Start from a template, then tweak agents.", done: !!companies.data?.length },
    { title: "Connect a model", hint: "Optional: Demo Mode runs offline.", done: modelReady, optional: true,
      action: <Link to={`/w/${w}/settings#providers`} className="text-primary hover:underline">Connect</Link> },
    { title: "Run a goal", hint: "Tell the team what to build.", done: hasRun,
      action: onRun && <button onClick={onRun} className="text-primary hover:underline">Run</button> },
    { title: "Review the results", hint: "Files, diffs and the final report.", done: finished,
      action: <Link to={`/w/${w}/artifacts`} className="text-primary hover:underline">Open</Link> },
  ];
  const done = steps.filter((s) => s.done).length;
  const next = steps.findIndex((s) => !s.done && !s.optional);
  const expanded = open ?? !companies.data?.length; // start collapsed once a team exists, so the canvas stays clear

  return (
    <div className="pointer-events-auto w-[290px] overflow-hidden rounded-2xl border border-border bg-card shadow-lg animate-fade-up" role="region" aria-label="Getting started">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button onClick={() => setOpen(!expanded)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={expanded}>
          <Progress value={done / steps.length} />
          <div className="min-w-0">
            <div className="text-sm font-semibold">Getting started</div>
            <div className="truncate text-[11px] text-muted-foreground">{done} of {steps.length} done{!expanded && next >= 0 ? ` · Next: ${steps[next].title}` : ""}</div>
          </div>
          <ChevronDown className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", !expanded && "-rotate-90")} />
        </button>
        <button onClick={() => setOnboarded(true)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Dismiss getting started">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded && (
        <>
          <ol className="space-y-0.5 border-t border-border px-2 py-2">
            {steps.map((s, i) => (
              <li key={s.title} className={cn("flex items-start gap-2.5 rounded-lg px-1.5 py-1.5", i === next && "bg-accent/60")}>
                <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                  s.done ? "border-success bg-success text-white" : "border-border text-muted-foreground")}>
                  {s.done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[13px] font-medium", s.done && "text-muted-foreground line-through decoration-1")}>
                    {s.title}{s.optional && <span className="ml-1 text-[10px] font-normal text-muted-foreground no-underline">optional</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{s.hint}</div>
                </div>
                {!s.done && s.action && <span className="mt-0.5 text-xs font-medium">{s.action}</span>}
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t border-border px-3.5 py-2 text-xs">
            <Link to={`/w/${w}/guide`} className="flex items-center gap-1 text-muted-foreground hover:text-foreground"><BookOpen className="h-3.5 w-3.5" />Read the guide</Link>
            {done === steps.length && <button onClick={() => setOnboarded(true)} className="font-medium text-primary hover:underline">All set, hide</button>}
          </div>
        </>
      )}
    </div>
  );
}

function Progress({ value }: { value: number }) {
  const r = 13, c = 2 * Math.PI * r;
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="16" cy="16" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="3" />
      <circle cx="16" cy="16" r={r} fill="none" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - value)} className="transition-[stroke-dashoffset] duration-500" />
    </svg>
  );
}
