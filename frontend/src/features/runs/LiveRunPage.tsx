import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, CircleStop, Download, FileCode2, FileText, Footprints, ListTodo, Loader2, Pause, Play, Wrench, History,
  MessagesSquare, UsersRound, Globe,
} from "lucide-react";
import { fetchRaw } from "@/lib/api";
import { RUN_STATUS } from "@/lib/meta";
import { cn, download } from "@/lib/utils";
import { useRun, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { AgentOut, EdgeOut, PermissionLevel } from "@/types";
import { AgentAvatar, ConnectionDot, EmptyState, PermissionBadge } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { ConfirmDialog, Select, Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/overlays";
import { ApprovalCard } from "./ApprovalCard";
import { Composer, type ComposerPayload } from "@/components/Composer";
import { sendToRun } from "./sendToRun";
import { ResizeHandle, usePanelWidth } from "@/components/ResizeHandle";
import { BrowserView } from "./BrowserView";
import { isBrowsing } from "./browserSteps";
import { RunFeed, ToolLog, type FeedFilter } from "./RunFeed";
import { RunGraph } from "./RunGraph";
import { QuestionCard, type AwaitingQuestion } from "./QuestionCard";
import { TaskBoard, Timeline, UsageMeter } from "./RunWidgets";
import { Ledger } from "./Ledger";
import { TeamView } from "./TeamView";
import { replayTo, TERMINAL } from "./runState";
import { useRunStream } from "./useRunStream";

const SIDE_PANEL_MAX = () => Math.max(360, Math.round(window.innerWidth * 0.72));

export default function LiveRunPage() {
  const w = useWorkspaceId();
  const { runId = "" } = useParams();
  const run = useRun(w, runId);
  const snap = run.data?.snapshot as { agents?: AgentOut[]; edges?: EdgeOut[]; departments?: Record<string, { color: string }> } | undefined;
  // snapshot at run start; agents hired mid-run come from events (the snapshot is also updated server-side for reloads)
  const baseAgents = React.useMemo(() => snap?.agents ?? [], [snap]);
  const names = React.useMemo(() => Object.fromEntries(baseAgents.map((a) => [a.id, a.name])), [baseAgents]);
  const { state: liveState, conn, send, events, eventCount } = useRunStream(w, run.data ? runId : undefined, names);
  const [cursor, setCursor] = React.useState<number | null>(null);
  const state = React.useMemo(() => (cursor === null ? liveState : replayTo(events, cursor, names)), [cursor, liveState, events, names, eventCount]); // eslint-disable-line react-hooks/exhaustive-deps
  // during replay, only agents that existed at the cursor are shown
  const hiredIds = React.useMemo(() => new Set(liveState.extraAgents.map((a) => a.id)), [liveState.extraAgents]);
  const agentsList = React.useMemo(() => {
    const visible = [...baseAgents.filter((a) => !hiredIds.has(a.id) || state.extraAgents.some((x) => x.id === a.id)),
      ...state.extraAgents.filter((a) => !baseAgents.some((b) => b.id === a.id))];
    return visible.map((a) => ({ ...a, ...(state.agentPatches[a.id] ?? {}) }) as AgentOut);
  }, [baseAgents, hiredIds, state.extraAgents, state.agentPatches]);
  const edgesList = React.useMemo(() => {
    const ids = new Set(agentsList.map((a) => a.id));
    const all = [...(snap?.edges ?? []), ...state.extraEdges.filter((e) => !(snap?.edges ?? []).some((x) => x.id === e.id))];
    return all.filter((e) => ids.has(e.source_agent_id) && ids.has(e.target_agent_id));
  }, [snap, state.extraEdges, agentsList]);
  const agents = React.useMemo(() => Object.fromEntries(agentsList.map((a) => [a.id, a])), [agentsList]);
  const departments = React.useMemo(() => ({ ...(snap?.departments ?? {}), ...state.departments }), [snap, state.departments]);
  const filter = useApp((s) => s.chatFilter);
  const setFilter = useApp((s) => s.setChatFilter);
  const [tab, setTab] = React.useState("feed");
  const panel = usePanelWidth("run-side-panel", Math.round(window.innerWidth * 0.4), 340, SIDE_PANEL_MAX);
  const [stopping, setStopping] = React.useState(false);
  const status = liveState.status;
  const terminal = TERMINAL.has(status);
  const isLive = !terminal;
  const browsing = Object.values(state.activity).some(isBrowsing);

  React.useEffect(() => { if (liveState.pendingApproval && cursor !== null) setCursor(null); }, [liveState.pendingApproval]); // eslint-disable-line react-hooks/exhaustive-deps

  const overlay = React.useMemo(() => ({
    status: state.agentStatus, activity: state.activity, lastMessage: state.lastMessage, streaming: state.streaming, thinking: state.thinking,
    activeEdges: state.activeEdges, tokens: state.usage.per_agent ?? {}, pendingApprovalAgent: state.pendingApproval?.agent_id ?? null,
    departments, names: Object.fromEntries(agentsList.map((a) => [a.id, a.name])),
    fresh: Object.fromEntries(Object.entries(state.fresh).filter(([, t]) => Date.now() - t < 3000).map(([k]) => [k, true])),
  }), [state, departments, agentsList]);

  const control = (action: "pause" | "resume" | "step" | "stop") => { send({ type: "control", action }); if (action === "stop") toast("Stopping run…"); };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [role=dialog]") || terminal) return;
      if (e.key === " " && !e.repeat) { e.preventDefault(); control(status === "paused" ? "resume" : "pause"); }
      if (e.key === "n" && run.data?.mode === "step") { e.preventDefault(); control("step"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (run.isLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (run.isError || !run.data) return <EmptyState icon={History} title="Run not found" description={(run.error as Error)?.message} />;
  const r = run.data;
  const st = RUN_STATUS[status] ?? RUN_STATUS.queued;
  const maxSeq = liveState.lastSeq;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label="Back to runs"><Link to={`/w/${w}/runs`}><ArrowLeft /></Link></Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant={st.variant} className={cn(status === "running" && "animate-pulse")}>{st.label}</Badge>
            <h1 className="truncate text-sm font-semibold" title={r.goal}>{r.goal}</h1>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="capitalize">{r.mode}</span>·<PermissionBadge level={r.permission_level as PermissionLevel} />
            {!!(r.budget as Record<string, unknown> | undefined)?.force_mock && <Badge variant="secondary">Demo Mode</Badge>}
            {(liveState.reason && status !== "running") && <span className="truncate text-warning">{liveState.reason}</span>}
            <ConnectionDot state={conn} />
          </div>
        </div>
        <UsageMeter usage={{ max_turns: Number(r.budget?.max_turns ?? 0) || undefined, max_tokens: Number(r.budget?.max_tokens ?? 0) || undefined, max_cost_usd: Number(r.budget?.max_cost_usd ?? 0) || undefined, timeout_s: Number(r.budget?.timeout_s ?? 0) || undefined, ...state.usage }} />
        <div className="flex items-center gap-1.5">
          {isLive && (
            <>
              {status === "paused" || status === "awaiting_user" ? (
                <Tip content="Resume (Space)"><Button size="sm" variant="secondary" onClick={() => control("resume")} disabled={!!liveState.pendingApproval}><Play />Resume</Button></Tip>
              ) : (
                <Tip content="Pause after the current turn (Space)"><Button size="sm" variant="secondary" onClick={() => control("pause")}><Pause />Pause</Button></Tip>
              )}
              {r.mode === "step" && <Tip content="Run exactly one agent turn (N)"><Button size="sm" onClick={() => control("step")} data-testid="next-turn"><Footprints />Next turn</Button></Tip>}
              <Tip content="Kill switch: stop immediately"><Button size="sm" variant="destructive" onClick={() => setStopping(true)}><CircleStop />Stop</Button></Tip>
            </>
          )}
          {terminal && (
            <>
              <Button asChild size="sm" variant="secondary"><Link to={`/w/${w}/artifacts/${runId}`}><FileCode2 />Artifacts</Link></Button>
              <Button size="sm" variant="ghost" onClick={async () => { const res = await fetchRaw(`/api/v1/w/${w}/runs/${runId}/report?download=true`); download(`run-report-${runId.slice(0, 8)}.md`, await res.text(), "text/markdown"); }}><Download />Report</Button>
            </>
          )}
        </div>
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <AgentStrip agents={agentsList} state={state} onBrowse={() => setTab("browser")} />
          <div className="relative min-h-0 flex-1">
          {agentsList.length ? <RunGraph agents={agentsList} edges={edgesList} overlay={overlay} departments={departments} /> : null}
          {cursor !== null && (
            <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-primary/40 bg-elevated/95 px-3 py-1 text-xs shadow-lg backdrop-blur animate-in fade-in-0">
              Replaying · event #{cursor} <button className="ml-2 font-medium text-primary hover:underline" onClick={() => setCursor(null)}>Back to {isLive ? "live" : "end"}</button>
            </div>
          )}
          </div>
        </div>

        <ResizeHandle side="right" label="Resize the side panel" width={panel.width} onResize={panel.set} onReset={panel.reset} min={panel.min} max={panel.max()} />
        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 shrink-0 flex-col" style={{ width: panel.width }} data-testid="run-side-panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
            <TabsList className="max-w-full overflow-x-auto">
              <TabsTrigger value="feed"><MessagesSquare />Feed</TabsTrigger>
              <TabsTrigger value="team" data-testid="tab-team"><UsersRound />Team <span className="tabular-nums text-muted-foreground">{agentsList.filter((a) => a.active !== false).length}</span></TabsTrigger>
              <TabsTrigger value="tasks"><ListTodo />Tasks <span className="tabular-nums text-muted-foreground">{Object.keys(state.tasks).length}</span></TabsTrigger>
              <TabsTrigger value="browser" data-testid="tab-browser"><Globe className={cn(browsing && "animate-pulse text-success")} />Browser
                {!!state.browser.length && <span className="tabular-nums text-muted-foreground">{state.browser.length}</span>}</TabsTrigger>
              <TabsTrigger value="tools"><Wrench />Tools</TabsTrigger>
              <TabsTrigger value="report" disabled={!terminal}><FileText />Report</TabsTrigger>
            </TabsList>
            {tab === "feed" && (
              <div className="ml-auto shrink-0">
                <Select ariaLabel="Feed filter" value={filter} onValueChange={(v) => setFilter(v as FeedFilter)} className="h-7 w-[150px] text-xs"
                  options={[{ value: "all", label: "All messages" }, { value: "user", label: "User-facing only" }, { value: "internal", label: "Internal only" }]} />
              </div>
            )}
          </div>
          <TabsContent value="feed" className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col">
            <div className="min-h-0 flex-1"><RunFeed state={state} agents={agents} filter={filter} /></div>
            {cursor === null && liveState.pendingApproval && (
              <div className="px-3 pb-2"><ApprovalCard key={liveState.pendingApproval.id} approval={liveState.pendingApproval} agent={agents[liveState.pendingApproval.agent_id]}
                onDecide={(ok, scope, reason) => send({ type: ok ? "approve" : "reject", approval_id: liveState.pendingApproval!.id, scope, reason })} /></div>
            )}
            {terminal && state.summary && cursor === null && (
              <div className="border-t border-border bg-success/5 px-4 py-3 text-sm"><span className="font-semibold">Outcome: </span>{state.summary}</div>
            )}
            {cursor === null && <InterjectBox agents={agentsList} awaiting={liveState.awaiting} finished={terminal} paused={status === "paused" && r.mode !== "step"}
              onSend={(p, to) => void sendToRun(w, runId, p, to, send)} />}
          </TabsContent>
          <TabsContent value="team" className="min-h-0 flex-1 overflow-y-auto"><TeamView agents={agentsList} state={state} departments={departments} /></TabsContent>
          <TabsContent value="tasks" className="min-h-0 flex-1 overflow-y-auto"><TaskBoard tasks={Object.values(state.tasks)} agents={agents} />
            <Ledger items={Object.values(state.ledger)} agents={agents} /></TabsContent>
          <TabsContent value="browser" className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"><BrowserView state={state} agents={agents} w={w} runId={runId} /></TabsContent>
          <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto"><ToolLog state={state} agents={agents} /></TabsContent>
          <TabsContent value="report" className="min-h-0 flex-1 overflow-y-auto"><ReportView w={w} runId={runId} enabled={terminal} /></TabsContent>
        </Tabs>
      </div>
      <Timeline items={liveState.timeline} maxSeq={maxSeq} cursor={cursor} onCursor={setCursor} agents={agents} live={isLive} />
      <ConfirmDialog open={stopping} onOpenChange={setStopping} title="Stop this run?" destructive confirmLabel="Stop run"
        description="The kill switch cancels the current turn immediately. Files already written stay in the project; a report is still generated."
        onConfirm={() => control("stop")} />
    </div>
  );
}

function AgentStrip({ agents, state, onBrowse }: { agents: AgentOut[]; state: ReturnType<typeof replayTo>; onBrowse: () => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border/60 bg-surface/40 px-3 py-2">
      {agents.map((a) => (
        <Tip key={a.id} content={state.activity[a.id] || state.agentStatus[a.id] || "idle"}>
          <div className="flex items-center gap-1.5 rounded-full border border-border bg-elevated/90 py-0.5 pl-0.5 pr-2 text-[11px] shadow-sm transition-colors">
            <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} status={state.agentStatus[a.id] ?? "idle"} size={20} />{a.name}
            {isBrowsing(state.activity[a.id]) && (
              <button onClick={onBrowse} aria-label={`Watch ${a.name}'s browser`} data-testid="agent-browsing"
                className="flex items-center gap-0.5 text-success hover:underline"><Globe className="h-3 w-3 animate-pulse" />browsing</button>
            )}
          </div>
        </Tip>
      ))}
    </div>
  );
}

/** Talk to the team with the same message box as the chat (text, files, images). While live this steers the run (and resumes
 *  it if it was paused); after it finished it continues the same run like a chat. */
function InterjectBox({ agents, awaiting, onSend, finished, paused }: {
  agents: AgentOut[]; awaiting: AwaitingQuestion | null; finished?: boolean; paused?: boolean;
  onSend: (p: ComposerPayload, to?: string) => void;
}) {
  const [to, setTo] = React.useState<string>("all");
  const asker = awaiting ? agents.find((a) => a.id === awaiting.agent_id) : undefined;
  const send = (p: ComposerPayload) => {
    onSend(p, to === "all" ? undefined : to);
    toast.success(finished ? "Continuing the run" : to === "all" ? "Sent to everyone" : `Sent to ${agents.find((a) => a.id === to)?.name}`,
      { duration: 1500, description: finished ? "Same team, same files and history." : paused ? "The run resumes." : undefined });
  };
  return (
    <div className="max-h-[60dvh] overflow-y-auto pt-1">
      {awaiting && (
        <div className="mb-2 px-3">
          <QuestionCard key={awaiting.question} awaiting={awaiting} agent={asker}
            onAnswer={(answer) => { onSend({ text: answer, files: [], images: [] }, awaiting.agent_id); toast.success(`Answered ${asker?.name ?? "the agent"}`, { duration: 1500 }); }} />
        </div>
      )}
      <Composer ariaLabel="Interjection" testId="interject"
        placeholder={awaiting ? "Or message the team…" : finished ? "Ask for a change or a next step: the team continues from where it stopped…" : "Steer the team: text, files or images…"}
        hint={paused && !finished ? <span className="text-warning">Sending resumes the run</span> : undefined}
        onSend={send}
        extra={<Select ariaLabel="Send to" value={to} onValueChange={setTo} className="h-7 w-[130px] text-xs"
          options={[{ value: "all", label: finished ? "Entry agent" : "Everyone" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />} />
    </div>
  );
}

function ReportView({ w, runId, enabled }: { w: string; runId: string; enabled: boolean }) {
  const q = useQuery({ queryKey: ["report", w, runId], enabled, queryFn: async () => (await fetchRaw(`/api/v1/w/${w}/runs/${runId}/report`)).text() });
  if (!enabled) return <p className="p-6 text-sm text-muted-foreground">The report is generated when the run ends.</p>;
  if (q.isLoading) return <div className="space-y-2 p-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-4" />)}</div>;
  return <div className="p-4"><Markdown>{q.data ?? ""}</Markdown></div>;
}
