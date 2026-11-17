import * as React from "react";
import { Bot, CheckCheck, Circle, CircleCheck, Coins, FilePen, FileText, FolderOpen, Layers, Loader2, Search, ShieldCheck, Sparkles, Timer, Wrench, type LucideIcon } from "lucide-react";
import { formatTokens } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { useWorkspaceId } from "@/hooks/queries";
import { AgentAvatar, EmptyState } from "@/components/common";
import { BrowserView } from "@/features/runs/BrowserView";
import { ReviewRounds } from "@/features/runs/ReviewRounds";
import type { RunLive, ToolCall } from "@/features/runs/runState";
import type { AgentOut, TaskOut } from "@/types";
import { useRunView } from "./runView";

const ArtifactsPage = React.lazy(() => import("@/features/artifacts/ArtifactsPage"));

/** The Changes tab: the left rail's Changes page, showing this conversation's run. */
export function ChangesTab() {
  const runId = useRunView((v) => v.runId);
  return (
    <div className="conversation-page-tab">
      <React.Suspense fallback={<p className="conversation-detail-empty">Loading changes.</p>}>
        <ArtifactsPage runId={runId ?? undefined} />
      </React.Suspense>
    </div>
  );
}

/** The Browser tab: each step the team's agents took in their browser, with the screenshot of that moment. */
export function BrowserTab() {
  const w = useWorkspaceId();
  const runId = useRunView((v) => v.runId);
  const live = useRunView((v) => v.live);
  const state = useRunView((v) => v.state);
  const agents = useRunView((v) => v.agents);
  return (
    <div className="conversation-detail-panel">
      {runId && state ? (
        <BrowserView state={state} agents={agents} w={w} runId={runId} live={live} />
      ) : (
        <p className="conversation-detail-empty">Start a conversation to see its browser.</p>
      )}
    </div>
  );
}

/** The Usage tab: a dashboard of the run's exact usage. Headline numbers first, then the token mix and the work it took. */
export function UsageTab() {
  const state = useRunView((v) => v.state);
  return (
    <div className="conversation-detail-panel">
      {state ? <UsageDashboard usage={state.usage} /> : <p className="conversation-detail-empty">Start a conversation to see its usage.</p>}
    </div>
  );
}

function UsageDashboard({ usage }: { usage: RunLive["usage"] }) {
  const money = useMoney();
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_tokens ?? 0;
  const written = usage.cache_write_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cb = usage.cost_breakdown ?? {};
  const parts = [
    { label: "Fresh input", tokens: Math.max(0, input - cached - written), cost: cb.input ?? 0, tone: "primary", hint: "Read by the model for the first time" },
    { label: "Cached input", tokens: cached, cost: cb.cached_input ?? 0, tone: "steel", hint: input ? `${Math.round((cached / input) * 100)}% of input came from the cache` : "Reused from the cache" },
    { label: "Cache writes", tokens: written, cost: cb.cache_write ?? 0, tone: "warning", hint: "Stored so later calls can reuse them" },
    { label: "Output", tokens: output, cost: cb.output ?? 0, tone: "success", hint: usage.reasoning_tokens ? `${formatTokens(usage.reasoning_tokens)} of it was reasoning` : "Replies and tool calls" },
  ];
  const tokenSum = parts.reduce((n, p) => n + p.tokens, 0);
  const calls = usage.llm_calls ?? 0;
  const failed = usage.tool_failures ?? 0;
  const seconds = Math.round((usage.model_ms ?? 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  const work: { icon: LucideIcon; label: string; value: string; hint: string }[] = [
    { icon: Bot, label: "Agent turns", value: (usage.agent_runs ?? 0).toLocaleString(), hint: `${calls.toLocaleString()} model calls` },
    { icon: Wrench, label: "Tool calls", value: (usage.tool_calls ?? 0).toLocaleString(), hint: failed ? `${failed} failed` : "None failed" },
    { icon: Search, label: "Searches", value: (usage.searches ?? 0).toLocaleString(), hint: "Code and web lookups" },
    { icon: FolderOpen, label: "Folder listings", value: (usage.listings ?? 0).toLocaleString(), hint: "Directories browsed" },
    { icon: FileText, label: "Files read", value: (usage.file_reads ?? 0).toLocaleString(), hint: usage.redundant_reads ? `${usage.redundant_reads} were already in context` : "Each file loaded once" },
    { icon: FilePen, label: "Files changed", value: (usage.files_changed ?? 0).toLocaleString(), hint: usage.file_writes ? `${usage.file_writes} write operations` : "No writes" },
    { icon: CheckCheck, label: "Checks run", value: (usage.verifications ?? 0).toLocaleString(), hint: "Project checks and tests" },
    { icon: Timer, label: "Model time", value: minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`, hint: "Waiting on the model" },
  ];
  const estimated = usage.estimated_calls && usage.estimated_calls === usage.llm_calls;

  return (
    <div className="usage-dash">
      <header className="usage-head">
        <h2>Usage</h2>
        <p>{estimated ? "Estimated" : "From Azure"} &middot; {calls.toLocaleString()} model calls</p>
      </header>

      <section className="usage-kpis">
        <UsageKpi icon={Coins} label="Cost" value={money(usage.cost_usd)} hint="At Azure rates for this run" />
        <UsageKpi icon={Layers} label="Tokens" value={formatTokens(usage.tokens)} hint={`${usage.tokens.toLocaleString()} exactly`} />
        <UsageKpi icon={Sparkles} label="Model calls" value={calls.toLocaleString()} hint={`${(usage.agent_runs ?? 0).toLocaleString()} agent turns`} />
        <UsageKpi icon={Wrench} label="Tool calls" value={(usage.tool_calls ?? 0).toLocaleString()} hint={failed ? `${failed} failed` : "None failed"} />
      </section>

      <section className="usage-card">
        <h3>Where the tokens went <span>{formatTokens(tokenSum)} in total</span></h3>
        <div className="usage-bar" role="img" aria-label="Token mix">
          {parts.map((p) => (
            <span key={p.label} data-tone={p.tone} style={{ flexGrow: p.tokens }} />
          ))}
        </div>
        <ul className="usage-legend">
          {parts.map((p) => (
            <li key={p.label}>
              <span className="usage-dot" data-tone={p.tone} aria-hidden="true" />
              <div className="usage-legend-text">
                <strong>{p.label}</strong>
                <span>{p.hint}</span>
              </div>
              <span className="usage-num">{p.tokens.toLocaleString()}</span>
              <span className="usage-num usage-share">{tokenSum ? Math.round((p.tokens / tokenSum) * 100) : 0}%</span>
              <span className="usage-num">{money(p.cost)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="usage-card">
        <h3>Work done</h3>
        <div className="usage-tiles">
          {work.map((w) => (
            <div key={w.label} className="usage-tile">
              <w.icon aria-hidden="true" />
              <span className="usage-tile-value">{w.value}</span>
              <span className="usage-tile-label">{w.label}</span>
              <span className="usage-tile-hint">{w.hint}</span>
            </div>
          ))}
        </div>
      </section>

      <p className="usage-rates">gpt-6-luna Standard: $0.10 input, $0.01 cached, $0.125 cache writes, $0.50 output per 1M tokens (prompts over 272K: 2x input, 1.5x output). Change rates in Settings &gt; Model &gt; Advanced.</p>
    </div>
  );
}

function UsageKpi({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: string; hint: string }) {
  return (
    <div className="usage-kpi">
      <Icon aria-hidden="true" />
      <span className="usage-kpi-label">{label}</span>
      <span className="usage-kpi-value">{value}</span>
      <span className="usage-kpi-hint">{hint}</span>
    </div>
  );
}

/** The Review tab: the latest verdict, every review round, and the findings of the round picked from them. */
export function ReviewTab() {
  const state = useRunView((v) => v.state);
  return (
    <div className="conversation-detail-panel">
      {state && state.reviews.length > 0 ? (
        <ReviewRounds rounds={state.reviews} />
      ) : (
        <EmptyState icon={ShieldCheck} title="No review rounds yet" description="When an owner finishes a round, its specialists review the work. Their verdicts and findings appear here." />
      )}
    </div>
  );
}

/** The To do tab of the floating chat: the team's checklist and its delegated tasks. */
export function TodoTab() {
  const state = useRunView((v) => v.state);
  const agents = useRunView((v) => v.agents);
  return (
    <div className="conversation-detail-panel">
      {state ? (
        <TodoBody state={state} agents={agents} />
      ) : (
        <p className="conversation-detail-empty">Start a conversation to see its to do list.</p>
      )}
    </div>
  );
}

/** The Tools tab of the floating chat: every tool call the run made, newest first. */
export function ToolsTab() {
  const state = useRunView((v) => v.state);
  const agents = useRunView((v) => v.agents);
  return (
    <div className="conversation-detail-panel">
      {state ? (
        <ToolsBody state={state} agents={agents} rows={Infinity} />
      ) : (
        <p className="conversation-detail-empty">No tool calls yet.</p>
      )}
    </div>
  );
}

/** The details card: a compact index of the run's to do list, its team, and its tool calls. The rail's toggle shows and hides it. */
export function DetailsPanel() {
  const state = useRunView((v) => v.state);
  const agents = useRunView((v) => v.agents);
  return (
    <aside className="details-card" aria-label="Details">
      {state ? (
        <RunSections state={state} agents={agents} />
      ) : (
        <p className="details-empty">Start a conversation to see its details.</p>
      )}
    </aside>
  );
}

function RunSections({ state, agents }: { state: RunLive; agents: Record<string, AgentOut> }) {
  const checklist = state.todos?.items ?? [];
  const tasks = Object.values(state.tasks);
  const doneItems = checklist.filter((item) => item.status === "completed").length;
  const doneTasks = tasks.filter((task) => task.status === "done").length;
  const team = Object.values(agents);
  const teamDone = team.filter((agent) => state.agentStatus[agent.id] === "done").length;
  const calls = Object.values(state.toolCalls);

  return (
    <>
      <Section
        title="To do"
        meta={checklist.length ? `${doneItems} of ${checklist.length} done` : tasks.length ? `${doneTasks} of ${tasks.length} done` : null}
      >
        <TodoBody state={state} agents={agents} />
      </Section>

      <Section title="Team" meta={`${teamDone} of ${team.length} done`}>
        <div className="details-team">
          {team.map((agent) => (
            <AgentAvatar key={agent.id} name={agent.name} color={agent.color} avatar={agent.avatar} status={state.agentStatus[agent.id] ?? "idle"} size={26} />
          ))}
        </div>
      </Section>

      <Section title="Tools" meta={`${calls.length} calls`}>
        <ToolsBody state={state} agents={agents} rows={6} />
      </Section>
    </>
  );
}

/** The checklist as a segmented bar and one line per item, then each delegated task with its owner and result. */
function TodoBody({ state, agents }: { state: RunLive; agents: Record<string, AgentOut> }) {
  const checklist = state.todos?.items ?? [];
  const tasks = Object.values(state.tasks);
  const doneItems = checklist.filter((item) => item.status === "completed").length;
  if (!checklist.length && !tasks.length) return <p className="details-empty">No to do items yet.</p>;
  return (
    <>
      {checklist.length > 0 && (
        <div className="details-segments" role="img" aria-label={`${doneItems} of ${checklist.length} done`}>
          {checklist.map((item, i) => (
            <span key={i} data-status={item.status} title={item.content} />
          ))}
        </div>
      )}
      <ul className="details-list">
        {checklist.map((item, i) => (
          <li key={i} className="details-row" data-status={item.status}>
            <StatusIcon status={item.status} />
            <span className="details-text">{item.content}</span>
          </li>
        ))}
        {tasks.map((task) => (
          <TaskRow key={task.key} task={task} owner={task.assignee_agent_id ? agents[task.assignee_agent_id] : undefined} />
        ))}
      </ul>
    </>
  );
}

/** Tool calls as one dot each (passed, failed, pending), then the newest `rows` calls by name and agent. */
function ToolsBody({ state, agents, rows }: { state: RunLive; agents: Record<string, AgentOut>; rows: number }) {
  const calls = Object.values(state.toolCalls).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  if (!calls.length) return <p className="details-empty">No tool calls yet.</p>;
  return (
    <>
      <div className="details-dots" aria-hidden="true">
        {calls.slice(-24).map((call) => (
          <span key={call.call_id} data-tone={toolTone(call)} title={call.tool} />
        ))}
      </div>
      <ul className="details-list">
        {calls.slice(-rows).reverse().map((call) => (
          <li key={call.call_id} className="details-row">
            <span className="details-dot" data-tone={toolTone(call)} aria-hidden="true" />
            <span className="details-text details-mono">{call.tool}</span>
            <span className="details-muted">{agents[call.agent_id]?.name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Section({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="details-section" aria-label={title}>
      <div className="details-section-head">
        <span className="details-section-title">{title}</span>
        {meta && <span className="details-meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "completed" || status === "done") return <CircleCheck className="details-icon" aria-hidden="true" />;
  if (status === "in_progress" || status === "review") return <Loader2 className="details-icon animate-spin" aria-hidden="true" />;
  return <Circle className="details-icon" aria-hidden="true" />;
}

function TaskRow({ task, owner }: { task: TaskOut; owner?: AgentOut }) {
  return (
    <li className="details-row is-task" data-status={task.status} title={task.description}>
      <StatusIcon status={task.status} />
      <span className="details-stack">
        <span className="details-text">
          <span className="details-key">{task.key}</span> {task.title}
        </span>
        {task.result && (task.status === "done" || task.status === "blocked" || task.status === "waiting") && (
          <span className="details-sub">{task.result}</span>
        )}
      </span>
      {owner && <AgentAvatar name={owner.name} color={owner.color} avatar={owner.avatar} size={16} />}
    </li>
  );
}

function toolTone(call: ToolCall): "pending" | "ok" | "failed" {
  if (call.ok === undefined) return "pending";
  return call.ok ? "ok" : "failed";
}
