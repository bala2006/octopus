/**
 * The run's Browser tab. Each agent's steps are listed on the left. The selected step is on the right, with the tab's
 * screenshot and a details panel that shows what the step did, the console messages it printed, and the tool's output.
 * While the run is live it streams the real tab (Chromium screencast) and you can take control of it.
 */
import * as React from "react";
import { AlertTriangle, Camera, Globe, Hand, ImageOff, Loader2, MousePointer2, Radio } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentOut } from "@/types";
import { AgentAvatar, EmptyState } from "@/components/common";
import type { BrowserAction, RunLive } from "./runState";
import {
  browserAgents,
  consoleLines,
  consoleTotals,
  describeAction,
  frameFor,
  hostOf,
  isBrowsing,
  timeOf,
  type ConsoleLine,
} from "./browserSteps";
import { controlHandlers, useLiveBrowser } from "./useLiveBrowser";

// screenshot blobs by URL; small LRU so stepping back and forth through a run doesn't refetch
const cache = new Map<string, string>();
const CACHE_MAX = 60;

function useFrame(url: string | null): { src?: string; error?: string } {
  const [res, setRes] = React.useState<{ src?: string; error?: string }>({});
  React.useEffect(() => {
    if (!url) { setRes({}); return; }
    const hit = cache.get(url);
    if (hit) { setRes({ src: hit }); return; }
    let alive = true;
    setRes((r) => ({ src: r.src })); // keep showing the previous frame until the next one arrives
    fetchRaw(url).then((r) => r.blob()).then((b) => {
      const src = URL.createObjectURL(b);
      cache.set(url, src);
      if (cache.size > CACHE_MAX) {
        const [k, v] = cache.entries().next().value as [string, string];
        cache.delete(k);
        URL.revokeObjectURL(v);
      }
      if (alive) setRes({ src });
    }).catch((e: Error) => alive && setRes({ error: e.message }));
    return () => { alive = false; };
  }, [url]);
  return res;
}

type Filter = "all" | "failed" | "errors";
type DetailTab = "details" | "console" | "output";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "errors", label: "Console errors" },
];

function matchesFilter(a: BrowserAction, filter: Filter): boolean {
  if (filter === "failed") return !a.ok;
  if (filter === "errors") return consoleLines(a).some((l) => l.level === "error");
  return true;
}

export function BrowserView({ state, agents, w, runId, live: runLive = false }: {
  state: RunLive; agents: Record<string, AgentOut>; w: string; runId: string;
  /** the run is going and the view follows it (not scrubbing the timeline): stream the real tab */
  live?: boolean;
}) {
  const actions = state.browser;
  const ids = browserAgents(actions);
  const browsingNow = Object.keys(state.activity).filter((id) => isBrowsing(state.activity[id]));
  const [picked, setPicked] = React.useState<string | null>(null);
  const [pinned, setPinned] = React.useState<number | null>(null); // a step the user clicked; null = follow the latest
  const [filter, setFilter] = React.useState<Filter>("all");
  const agentId = picked ?? browsingNow[0] ?? ids[0];
  const mine = React.useMemo(() => actions.map((a, i) => [a, i] as const).filter(([a]) => a.agent_id === agentId), [actions, agentId]);
  const shown = React.useMemo(() => mine.filter(([a]) => matchesFilter(a, filter)), [mine, filter]);
  const index = pinned !== null && actions[pinned]?.agent_id === agentId ? pinned : mine.length ? mine[mine.length - 1][1] : -1;
  const step = actions[index];
  const shot = frameFor(actions, index);
  const frame = useFrame(shot?.frame ? `/api/v1/w/${w}/runs/${runId}/browser/${shot.frame}` : null);
  const listRef = React.useRef<HTMLOListElement>(null);
  const liveImg = React.useRef<HTMLImageElement>(null);
  const screen = React.useRef<HTMLDivElement>(null);
  const lb = useLiveBrowser(w, runId, agentId, runLive && pinned === null, liveImg);
  const [control, setControl] = React.useState(false);
  React.useEffect(() => setControl(false), [agentId, lb.live]);
  React.useEffect(() => { if (control) screen.current?.focus(); }, [control]);
  const handlers = React.useMemo(() => controlHandlers(lb, liveImg), [lb]);
  const streaming = lb.live && pinned === null;
  React.useEffect(() => { if (pinned === null) listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" }); }, [mine.length, pinned]);

  if (!ids.length && !browsingNow.length) {
    return <EmptyState icon={Globe} title="No browser activity yet"
      description="When an agent opens a page, clicks or types in its browser, you'll see each step here with a screenshot of what its tab showed and the console messages it printed." />;
  }
  const live = agentId ? isBrowsing(state.activity[agentId]) : false;
  const shownUrl = streaming ? lb.url || step?.url : step?.url;
  const totals = agentId ? consoleTotals(actions, agentId) : { errors: 0, warnings: 0 };
  const failed = mine.filter(([a]) => !a.ok).length;
  const note = streaming
    ? "live view of the tab"
    : shot && shot !== step ? "showing the last screenshot before this step" : "";
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-view">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        {[...new Set([...browsingNow, ...ids])].map((id) => {
          const a = agents[id];
          const on = isBrowsing(state.activity[id]);
          return (
            <button key={id} onClick={() => { setPicked(id); setPinned(null); }} data-testid="browser-agent"
              className={cn("flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px]",
                id === agentId ? "border-primary/60 bg-primary/10" : "border-border bg-elevated/90 hover:bg-elevated")}>
              <AgentAvatar name={a?.name ?? "Agent"} color={a?.color} avatar={a?.avatar} status={state.agentStatus[id] ?? "idle"} size={18} />
              {a?.name ?? "Agent"}
              {on && <Radio className="h-3 w-3 animate-pulse text-success" aria-label="browsing now" />}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Summary steps={mine.length} failed={failed} errors={totals.errors} warnings={totals.warnings} />
        <div role="group" aria-label="Filter steps" className="ml-auto flex overflow-hidden rounded-md border border-border text-[11px]">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
              className={cn("px-2 py-1 transition-colors", filter === f.id ? "bg-primary/15 text-primary" : "hover:bg-elevated")}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[300px] shrink-0 flex-col border-r border-border/60">
          <ol ref={listRef} aria-label="Steps" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2 text-xs" data-testid="browser-steps">
            {shown.map(([a, i]) => (
              <StepRow key={a.seq || i} action={a} number={mine.findIndex(([, j]) => j === i) + 1} active={i === index} onPick={() => setPinned(i)} />
            ))}
            {!shown.length && <li className="px-2 py-3 text-muted-foreground">No steps match this filter.</li>}
            {live && <li className="flex items-center gap-2 px-2 py-1 text-success"><Loader2 className="h-3 w-3 animate-spin" />{state.activity[agentId!]}</li>}
          </ol>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          {/* the agent's tab */}
          <div className="m-3 overflow-hidden rounded-lg border border-border bg-background shadow-sm">
            <div className="flex items-center gap-2 border-b border-border bg-surface px-2 py-1.5 text-xs">
              <span className="flex gap-1" aria-hidden><i className="h-2 w-2 rounded-full bg-muted-foreground/30" /><i className="h-2 w-2 rounded-full bg-muted-foreground/30" /><i className="h-2 w-2 rounded-full bg-muted-foreground/30" /></span>
              <div className="min-w-0 flex-1 truncate rounded bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground" data-testid="browser-url" title={shownUrl}>
                {shownUrl || "about:blank"}
              </div>
              {streaming && (
                <span className="flex shrink-0 items-center gap-1 rounded bg-destructive/90 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white" data-testid="browser-live-badge">
                  <Radio className="h-3 w-3" />Live
                </span>
              )}
              {streaming && (
                <button onClick={() => setControl(!control)} data-testid="browser-control"
                  className={cn("flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[11px]", control ? "border-primary bg-primary/15 text-primary" : "border-border hover:bg-elevated")}
                  title={control ? "Give the tab back to the agent (Shift+Esc)" : "Click and type in the agent's tab yourself"}>
                  {control ? <><MousePointer2 className="h-3 w-3" />Release</> : <><Hand className="h-3 w-3" />Take control</>}
                </button>
              )}
              {live ? (
                <span className="flex shrink-0 items-center gap-1 text-success" data-testid="browser-live"><Loader2 className="h-3 w-3 animate-spin" />{state.activity[agentId!].replace(/^Browser:\s*/, "")}</span>
              ) : pinned !== null ? (
                <button className="shrink-0 text-primary hover:underline" onClick={() => setPinned(null)}>Latest</button>
              ) : null}
            </div>
            <div ref={screen} className={cn("relative flex h-[40vh] min-h-[200px] max-h-[460px] items-center justify-center bg-muted/30 outline-none", control && "cursor-crosshair ring-2 ring-primary")}
              tabIndex={control ? 0 : -1} data-testid="browser-screen"
              {...(control ? handlers : {})}
              onKeyDownCapture={(e) => { if (control && e.key === "Escape" && e.shiftKey) setControl(false); }}>
              {/* the real tab, streamed (always mounted so frames can be written into it) */}
              <img ref={liveImg} alt={step?.title || "Live browser tab"} data-testid="browser-live-frame" draggable={false}
                className={cn("h-full w-full select-none object-contain object-top", !streaming && "hidden")} />
              {streaming ? null : frame.src ? (
                <img src={frame.src} alt={step?.title || step?.url || "Browser screenshot"} data-testid="browser-frame"
                  className={cn("h-full w-full object-contain object-top", shot !== step && "opacity-80")} />
              ) : frame.error ? (
                <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground"><ImageOff className="h-5 w-5" />Screenshot not available ({frame.error})</div>
              ) : (
                <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground"><Globe className="h-5 w-5" />{live ? "Opening." : "No screenshot for this step"}</div>
              )}
            </div>
            {control && (
              <div className="border-t border-primary/40 bg-primary/5 px-2 py-1 text-[11px] text-primary">
                You're in control: clicks, scrolling and keys go to {agents[agentId!]?.name ?? "the agent"}'s tab. Shift+Esc or Release to hand it back.
              </div>
            )}
          </div>

          {step && !control && (
            <StepDetails key={index} step={step} agentName={agents[step.agent_id]?.name ?? "Agent"} note={note} />
          )}
        </section>
      </div>
    </div>
  );
}

function Summary({ steps, failed, errors, warnings }: { steps: number; failed: number; errors: number; warnings: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="browser-summary">
      <span className="font-medium text-foreground">{steps} {steps === 1 ? "step" : "steps"}</span>
      {failed > 0 && <span className="text-destructive">{failed} failed</span>}
      {errors > 0 && <span className="text-destructive" title="Each distinct message counts once, however many console calls printed it">{errors} distinct console {errors === 1 ? "error" : "errors"}</span>}
      {warnings > 0 && <span className="text-warning" title="Each distinct message counts once, however many console calls printed it">{warnings} distinct {warnings === 1 ? "warning" : "warnings"}</span>}
    </span>
  );
}

function StepRow({ action, number, active, onPick }: {
  action: BrowserAction; number: number; active: boolean; onPick: () => void;
}) {
  const errors = consoleLines(action).filter((l) => l.level === "error").length;
  const when = timeOf(action.ts);
  return (
    <li>
      <button type="button" onClick={onPick} aria-current={active ? "step" : undefined}
        className={cn("flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-elevated",
          active ? "border-primary/50 bg-primary/10" : "border-transparent")}>
        <span className={cn("mt-0.5 w-5 shrink-0 text-right tabular-nums text-[11px]", active ? "text-primary" : "text-muted-foreground")}>{number}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", !action.ok && "text-destructive")}>{describeAction(action)}</span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate font-mono">{hostOf(action.url) || action.tool.replace(/^browser_/, "")}</span>
            {when && <span className="shrink-0 tabular-nums">{when}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          {!action.ok && (
            <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-1.5 py-px text-[10px] font-medium text-destructive">
              <AlertTriangle className="h-2.5 w-2.5" />failed
            </span>
          )}
          {errors > 0 && (
            <span className="rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">
              {errors} console {errors === 1 ? "error" : "errors"}
            </span>
          )}
          {action.frame && <Camera className="h-3 w-3 text-muted-foreground" aria-label="screenshot" />}
        </span>
      </button>
    </li>
  );
}

/** The selected step: its outcome, then tabs for its details, console messages, and raw output. */
function StepDetails({ step, agentName, note }: { step: BrowserAction; agentName: string; note: string }) {
  const lines = consoleLines(step);
  const [tab, setTab] = React.useState<DetailTab>(lines.length ? "console" : "details");
  const tabs: { id: DetailTab; label: string; count?: number }[] = [
    { id: "details", label: "Details" },
    { id: "console", label: "Console", count: lines.length },
    { id: "output", label: "Output" },
  ];
  const detail = [timeOf(step.ts), step.tool, note].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="flex items-start gap-3 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={describeAction(step)}>{describeAction(step)}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{agentName}{detail ? ` · ${detail}` : ""}</div>
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
          step.ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive")}>
          {step.ok ? "Succeeded" : "Failed"}
        </span>
      </div>
      <div role="tablist" aria-label="Step details" className="mt-3 flex gap-1 border-b border-border px-3 text-xs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={cn("-mb-px flex items-center gap-1.5 border-b-2 px-2 py-1.5 transition-colors",
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="rounded bg-elevated px-1 text-[10px] tabular-nums">{t.count}</span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto p-4 text-xs">
        {tab === "details" && <Details step={step} />}
        {tab === "console" && <Console lines={lines} recorded={step.output !== undefined} />}
        {tab === "output" && <Output text={step.output} />}
      </div>
    </div>
  );
}

function Details({ step }: { step: BrowserAction }) {
  const rows: [string, React.ReactNode][] = [
    ["Action", describeAction(step)],
    ["Tool", step.tool],
    ["Page", step.title || "—"],
    ["URL", step.url ? <span className="break-all font-mono text-[11px]">{step.url}</span> : "—"],
    ["Result", step.ok ? "Succeeded" : "Failed"],
    ["Call", step.call_id ? <span className="font-mono text-[11px] text-muted-foreground">{step.call_id}</span> : "—"],
  ];
  const args = Object.keys(step.args ?? {});
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[6rem_1fr] gap-x-4 gap-y-2">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Arguments</h3>
        {args.length ? (
          <pre className="overflow-auto rounded-md bg-surface p-3 font-mono text-[11px] leading-5">{JSON.stringify(step.args, null, 2)}</pre>
        ) : (
          <p className="text-muted-foreground">This step took no arguments.</p>
        )}
      </div>
    </div>
  );
}

const LEVEL: Record<ConsoleLine["level"], { label: string; text: string; row: string }> = {
  error: { label: "Error", text: "text-destructive", row: "bg-destructive/10" },
  warning: { label: "Warning", text: "text-warning", row: "bg-warning/10" },
  info: { label: "Log", text: "text-muted-foreground", row: "" },
};

function Console({ lines, recorded }: { lines: ConsoleLine[]; recorded: boolean }) {
  if (!lines.length) {
    return <p className="text-muted-foreground">{recorded
      ? "No console messages in this step."
      : "This step's output was not saved, so its console messages are not available."}</p>;
  }
  return (
    <ol className="space-y-1 font-mono text-[11px] leading-5" aria-label="Console messages">
      {lines.map((line, i) => (
        <li key={i} className={cn("flex gap-3 rounded px-2 py-1", LEVEL[line.level].row)}>
          <span className={cn("w-14 shrink-0 font-semibold uppercase", LEVEL[line.level].text)}>{LEVEL[line.level].label}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{line.text}</span>
          {line.where && <span className="shrink-0 text-[10px] text-muted-foreground" title={line.where}>{line.where}</span>}
        </li>
      ))}
    </ol>
  );
}

function Output({ text }: { text?: string }) {
  if (!text) return <p className="text-muted-foreground">No output was recorded for this step.</p>;
  return <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5">{text}</pre>;
}
