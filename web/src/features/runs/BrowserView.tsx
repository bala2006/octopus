/**
 * The run's Browser tab: watch each agent's own browser tab. While the run is live it streams the real tab (Chromium
 * screencast) and you can take control of it; every step is listed with a screenshot, so stepping back and replaying a
 * finished run still works.
 */
import * as React from "react";
import { AlertTriangle, Camera, Globe, Hand, ImageOff, Loader2, MousePointer2, Radio } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentOut } from "@/types";
import { AgentAvatar, EmptyState } from "@/components/common";
import type { RunLive } from "./runState";
import { browserAgents, describeAction, frameFor, isBrowsing } from "./browserSteps";
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
  const agentId = picked ?? browsingNow[0] ?? ids[0];
  const mine = React.useMemo(() => actions.map((a, i) => [a, i] as const).filter(([a]) => a.agent_id === agentId), [actions, agentId]);
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
      description="When an agent opens a page, clicks or types in its browser, you'll see each step here with a screenshot of what its tab showed." />;
  }
  const live = agentId ? isBrowsing(state.activity[agentId]) : false;
  const shownUrl = streaming ? lb.url || step?.url : step?.url;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-view">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
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
      </div>

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
        <div ref={screen} className={cn("relative flex aspect-[16/10] items-center justify-center bg-muted/30 outline-none", control && "cursor-crosshair ring-2 ring-primary")}
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
            <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground"><Globe className="h-5 w-5" />{live ? "Opening…" : "No screenshot for this step"}</div>
          )}
        </div>
        {control && (
          <div className="border-t border-primary/40 bg-primary/5 px-2 py-1 text-[11px] text-primary">
            You're in control: clicks, scrolling and keys go to {agents[agentId!]?.name ?? "the agent"}'s tab. Shift+Esc or Release to hand it back.
          </div>
        )}
        {step && !control && (
          <div className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
            {step.title && <span className="font-medium text-foreground">{step.title} · </span>}
            {describeAction(step)}{streaming ? " · live view of the tab" : shot && shot !== step && " · showing the last screenshot before this step"}
          </div>
        )}
      </div>

      {/* every step this agent took */}
      <ol ref={listRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3 text-xs" data-testid="browser-steps">
        {mine.map(([a, i]) => (
          <li key={a.seq || i}>
            <button onClick={() => setPinned(i)} className={cn("flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-elevated",
              i === index && "bg-elevated ring-1 ring-primary/40")}>
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{mine.findIndex(([, j]) => j === i) + 1}</span>
              <span className={cn("min-w-0 flex-1 break-words", !a.ok && "text-destructive")}>
                {!a.ok && <AlertTriangle className="mr-1 inline h-3 w-3" />}{describeAction(a)}
                {!a.ok && a.note && <span className="block truncate text-[11px] opacity-80" title={a.note}>{a.note.replace(/^#+\s*\w+\s*/, "")}</span>}
              </span>
              {a.frame && <Camera className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-label="screenshot" />}
            </button>
          </li>
        ))}
        {live && <li className="flex items-center gap-2 px-2 py-1 text-success"><Loader2 className="h-3 w-3 animate-spin" />{state.activity[agentId!]}</li>}
      </ol>
    </div>
  );
}
