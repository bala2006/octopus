import * as React from "react";
import { tone } from "@/lib/palette";
import { ArrowRight, Ban, ChevronDown, CircleCheck, CircleX, FileCode2, Gavel, ListTodo, Loader2, Monitor, Pencil, Search, Settings2, Sparkles, Terminal, User, UserPlus, Wrench, type LucideIcon } from "lucide-react";
import { MESSAGE_TYPE_LABEL, statusMeta } from "@/lib/meta";
import { clockTime, cn, goalTitle, parseUtc } from "@/lib/utils";
import { fetchRaw } from "@/lib/api";
import { useWorkspaceId } from "@/hooks/queries";
import type { AgentOut, MessageOut } from "@/types";
import { AgentAvatar, StatusPill, TypingDots } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/primitives";
import type { OrgEvent, RunLive } from "./runState";
import { LiveWriting, ThinkingView } from "./LiveWriting";
import { humanizeStream } from "./streamView";
import { activitySummary, fileTotals, narrationParagraphs, phasesOf, segmentsOf, type Phase, type Step, type StepKind } from "./steps";

export type FeedFilter = "all" | "user" | "internal";

const TYPE_TONE: Record<string, string> = {
  proposal: "text-destructive border-destructive/40", objection: "text-terracotta border-terracotta/40", agreement: "text-olive border-olive/40",
  decision: "text-terracotta border-terracotta/40", critique: "text-terracotta border-terracotta/40", review_request: "text-olive border-olive/40",
  review_result: "text-olive border-olive/40", task: "text-steel border-steel/40", status_update: "text-steel border-steel/40",
  final_report: "text-primary border-primary/50", question: "text-warning border-warning/40", answer: "text-warning border-warning/40",
  user_interjection: "text-primary border-primary/40",
};

/** Opens one agent's own chat; provided by the panel that hosts the feed. */
export const AgentChatContext = React.createContext<((agentId: string) => void) | null>(null);

/** An agent's name that opens its chat when a host provides one. */
function AgentName({ agent, className, style }: { agent: AgentOut; className?: string; style?: React.CSSProperties }) {
  const open = React.useContext(AgentChatContext);
  if (!open) return <span className={className} style={style}>{agent.name}</span>;
  return <button type="button" onClick={() => open(agent.id)} className={cn(className, "hover:underline")} style={style} title={`Open ${agent.name}'s chat`}>{agent.name}</button>;
}

/** Whether a message belongs in one agent's chat: sent by it, to it, or about its work. */
export function inAgentChat(m: MessageOut, agentId: string): boolean {
  return m.from_agent_id === agentId || m.to_agent_id === agentId;
}

export function isUserFacing(m: MessageOut): boolean {
  return m.sender === "user" || !m.to_agent_id || m.type === "final_report";
}

type Item = ({ kind: "msg"; m: MessageOut } | { kind: "files"; ms: MessageOut[] } | { kind: "rejected"; r: Record<string, any> } | { kind: "org"; ev: OrgEvent } | { kind: "step"; step: Step } | { kind: "steps"; steps: Step[] }) & { seq: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The conversation feed. With `agentId` it is that agent's own chat: what it said and was told, and its steps. */
export function RunFeed({ state, agents, filter, showThoughts = true, agentId }: { state: RunLive; agents: Record<string, AgentOut>; filter: FeedFilter; showThoughts?: boolean; agentId?: string }) {
  const bottom = React.useRef<HTMLDivElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [stick, setStick] = React.useState(true);
  const items = React.useMemo(() => {
    const raw: Item[] = [];
    state.messages.forEach((m) => {
      if (agentId) { if (!inAgentChat(m, agentId)) return; }
      else if (filter === "user" && !isUserFacing(m)) return;
      if (filter === "internal" && (m.sender === "user" || !m.to_agent_id) && m.type !== "artifact_created") return;
      raw.push(m.type === "artifact_created" ? { kind: "files", ms: [m], seq: m._seq ?? 0 } : { kind: "msg", m, seq: m._seq ?? 0 });
    });
    if (filter !== "user" && !agentId) for (const r of state.rejected) raw.push({ kind: "rejected", r, seq: r.seq ?? 0 });
    if (!agentId) for (const ev of state.orgEvents) raw.push({ kind: "org", ev, seq: ev.seq });
    // A review round's specialist steps show in the Review tab, so the feed leaves them out.
    const folded = new Set(agentId ? [] : state.reviews.flatMap((r) => r.specialists.flatMap((s) => s.steps.map((x) => x.id))));
    for (const step of state.steps) if ((showThoughts || step.kind !== "thought") && (!agentId || step.agent_id === agentId) && !folded.has(step.id)) raw.push({ kind: "step", step, seq: step.seq });
    raw.sort((a, b) => a.seq - b.seq); // every item carries its event's seq, so the feed reads in the order things happened
    const out: Item[] = [];
    for (const it of raw) { // group consecutive file writes by the same agent, and consecutive steps by the same agent
      const last = out[out.length - 1];
      if (it.kind === "files" && last?.kind === "files" && last.ms[0].from_agent_id === it.ms[0].from_agent_id) last.ms.push(...it.ms);
      else if (it.kind === "step" && last?.kind === "steps" && last.steps[0].agent_id === it.step.agent_id) last.steps.push(it.step);
      else if (it.kind === "step") out.push({ kind: "steps", steps: [it.step], seq: it.seq });
      else out.push(it.kind === "files" ? { ...it, ms: [...it.ms] } : it);
    }
    return out;
  }, [state.messages, state.rejected, state.orgEvents, state.steps, state.reviews, filter, showThoughts, agentId]);
  const active = Object.entries(state.agentStatus).filter(([id, st]) => statusMeta(st).live && (!agentId || id === agentId));

  React.useEffect(() => { if (stick) bottom.current?.scrollIntoView({ block: "end" }); }, [items.length, stick, state.streaming]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full space-y-1 overflow-y-auto px-3 py-3" role="log" aria-live="polite" aria-label="Team conversation activity">
          {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Waiting for the first message…</p>}
          {items.map((it) => it.kind === "msg" ? <FeedMessage key={it.m.id} m={it.m} agents={agents} />
            : it.kind === "files" ? <FileGroup key={it.ms[0].id} ms={it.ms} agents={agents} />
            : it.kind === "org" ? <OrgItem key={`o${it.seq}`} ev={it.ev} agents={agents} />
            : it.kind === "steps" ? <StepRun key={`s${it.seq}`} steps={it.steps} agents={agents} />
            : it.kind === "rejected" ? <Rejected key={`r${it.seq}`} r={it.r} agents={agents} />
            : null)}
          {active.map(([aid, st]) => {
            const a = agents[aid];
            if (!a) return null;
            return (
              <div key={`live-${aid}`} className="flex gap-2.5 rounded-lg px-2 py-2 animate-fade-up">
                <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} status={st} size={28} />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 text-xs"><span className="font-semibold">{a.name}</span><StatusPill status={st} activity={state.activity[aid]} />
                    {state.live && state.turnStart[aid] ? <Elapsed since={state.turnStart[aid]} /> : null}</div>
                  {showThoughts && state.thinking[aid] && <ThinkingView text={state.thinking[aid]} live />}
                  {state.streaming[aid] && humanizeStream(state.streaming[aid]).length ? <LiveWriting raw={state.streaming[aid]} />
                    : !state.thinking[aid] && <TypingDots color={statusMeta(st).color} />}
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
      </div>
      {!stick && (
        <button onClick={() => { setStick(true); bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-elevated px-3 py-1 text-xs shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
          <ChevronDown className="h-3.5 w-3.5" />Jump to latest
        </button>
      )}
      </div>
    </div>
  );
}

/** A delegation brief or its result: the work itself shows up as files and task-board changes, so these collapse to one line. */
export const isDelegationMessage = (meta: Record<string, unknown>) => !!(meta.delegation || meta.delegation_result);

/** First meaningful line of a message, without markdown markers: the collapsed view of a delegation. */
export function firstLine(text: string): string {
  const line = goalTitle(text, "");
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function FeedMessage({ m, agents }: { m: MessageOut; agents: Record<string, AgentOut> }) {
  const from = m.from_agent_id ? agents[m.from_agent_id] : null;
  const to = m.to_agent_id ? agents[m.to_agent_id] : null;
  const meta = (m.meta ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const content = m.sender === "user" && typeof meta.display_content === "string" ? meta.display_content : m.content;
  const delegated = isDelegationMessage(meta);
  const [open, setOpen] = React.useState(!delegated && (content.length < 700 || m.type === "final_report"));
  const expandable = delegated ? content.trim().length > 0 : content.length >= 700 && m.type !== "final_report";
  const isUser = m.sender === "user";
  const verdict = meta.verdict as string | undefined;
  // The server stores attached images as file names; only strings are image names.
  const names = React.useMemo(() => (Array.isArray(meta.images) ? meta.images.filter((n: unknown): n is string => typeof n === "string") : []), [m.meta]);
  return (
    <article data-sender={isUser ? "user" : "agent"} className={cn("feed-message group rounded-lg px-2 py-2 animate-fade-up", !isUser && "transition-colors hover:bg-accent/30", m.type === "final_report" && "border border-primary/30 bg-primary/5")} aria-label={`${from?.name ?? "You"} to ${to?.name ?? "you"}`}>
      <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
        {from ? <AgentAvatar name={from.name} color={from.color} avatar={from.avatar} size={28} /> :
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary"><User className="h-3.5 w-3.5" /></div>}
        <div className={cn("min-w-0", isUser ? "flex max-w-[80%] flex-col items-end" : "flex-1")}>
          <div className={cn("feed-message-meta flex flex-wrap items-center gap-1.5 text-xs", isUser && "hidden")}>
            {from ? <AgentName agent={from} className="font-semibold" style={{ color: from.color }} /> : <span className="font-semibold">You</span>}
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-muted-foreground">{to ? <AgentName agent={to} /> : (m.type === "final_report" || m.type === "question" ? "You" : "Everyone")}{!to && meta.recipients ? ` (${meta.recipients} agents)` : ""}</span>
            <span className={cn("rounded border px-1.5 py-px text-[10px] font-medium", TYPE_TONE[m.type] ?? "text-muted-foreground border-border")}>{MESSAGE_TYPE_LABEL[m.type] ?? m.type}</span>
            {verdict && (verdict === "approve" ? <Badge variant="success"><CircleCheck className="h-3 w-3" />approved</Badge> : <Badge variant="warning"><CircleX className="h-3 w-3" />changes requested</Badge>)}
            {meta.debate && <Badge variant="outline"><Gavel className="h-3 w-3" />round {meta.debate.round}/{meta.debate.max_rounds}{meta.debate.status !== "open" ? ` · ${meta.debate.status}` : ""}</Badge>}
            {meta.review && <Badge variant="outline">rev {meta.review.revisions}/{meta.review.max_revisions}</Badge>}
            {meta.task_id && <Badge variant="secondary">{meta.task_id}</Badge>}
            {meta.awaiting_input && <Badge variant="warning">asks you</Badge>}
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground opacity-0 transition group-hover:opacity-100">t{m.turn_no} · {clockTime(m.created_at)}</span>
          </div>
          {delegated && !open ? (
            <button onClick={() => setOpen(true)} data-testid="delegation-collapsed" title="Show the full text"
              className="mt-0.5 block w-full truncate text-left text-[12px] text-muted-foreground hover:text-foreground">
              {meta.delegation_result ? "Result: " : ""}{firstLine(content) || "(empty)"}
            </button>
          ) : (
            <div className={cn("relative mt-1 text-[13px]", !open && "max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]", isUser && "rounded-2xl rounded-tr-sm bg-primary/25 px-3.5 py-2.5")}>
              <Markdown>{content}</Markdown>
            </div>
          )}
          {names.length > 0 && <GoalImages runId={m.run_id ?? ""} names={names} />}
          {Array.isArray(meta.files) && <div className="mt-2 flex flex-wrap gap-1.5">{meta.files.filter((file: unknown): file is string => typeof file === "string").map((file: string) => <span key={file} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]"><FileCode2 className="h-3 w-3" />{file}</span>)}</div>}
          {Array.isArray(meta.options) && meta.options.length > 0 && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Offered answers">
              {(meta.options as { label: string; recommended?: boolean }[]).map((o, i) => (
                <li key={i} className={cn("rounded-full border px-2 py-0.5 text-[11px]", o.recommended ? "border-olive/50 bg-olive/10 text-olive" : "border-border text-muted-foreground")}>
                  {i + 1}. {o.label}{o.recommended ? " · recommended" : ""}
                </li>
              ))}
            </ul>
          )}
          {expandable && (open || !delegated) && (
            <button onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] font-medium text-primary hover:underline">{open ? "Show less" : "Show more"}</button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Thumbnails of the images attached to a message (click to open full size). `names` are the saved file names. */
function GoalImages({ runId, names }: { runId: string; names: string[] }) {
  const w = useWorkspaceId();
  const [srcs, setSrcs] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!runId || !w) return;
    let alive = true;
    const made: string[] = [];
    for (const name of names) {
      fetchRaw(`/api/v1/w/${w}/runs/${runId}/attachments/${encodeURIComponent(name)}`).then((r) => r.blob()).then((b) => {
        const u = URL.createObjectURL(b);
        made.push(u);
        if (alive) setSrcs((s) => ({ ...s, [name]: u }));
      }).catch(() => undefined);
    }
    return () => { alive = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [w, runId, names]);
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="goal-images">
      {names.map((name) => srcs[name] ? (
        <a key={name} href={srcs[name]} target="_blank" rel="noreferrer" title="Open full size">
          <img src={srcs[name]} alt="Attached image" className="h-20 max-w-[10rem] rounded border border-border object-cover" />
        </a>
      ) : <span key={name} className="flex h-20 w-28 items-center justify-center rounded border border-border text-[10px] text-muted-foreground">Image</span>)}
    </div>
  );
}
function FileGroup({ ms, agents }: { ms: MessageOut[]; agents: Record<string, AgentOut> }) {
  const a = ms[0].from_agent_id ? agents[ms[0].from_agent_id] : null;
  return (
    <div className="flex gap-2.5 px-2 animate-fade-up">
      <div className="flex w-7 shrink-0 justify-center">{a && <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={22} />}</div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
      <FileCode2 className="h-3.5 w-3.5 text-olive" />
      <span style={a ? { color: tone(a.color) } : undefined} className="font-medium">{a?.name}</span>
      {ms.map((m) => (
        <span key={m.id} className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono">
          {String(m.meta?.path ?? "")}<span className="text-muted-foreground/70"> v{String(m.meta?.version ?? "")}</span>
        </span>
      ))}
      </div>
    </div>
  );
}

function OrgItem({ ev, agents }: { ev: OrgEvent; agents: Record<string, AgentOut> }) {
  const by = agents[ev.by];
  const who = agents[ev.agent_id];
  if (ev.kind === "created") {
    return (
      <div className="ml-[46px] flex items-center gap-2 rounded-lg border border-steel/30 bg-steel/5 px-2.5 py-2 text-xs animate-in fade-in-0 slide-in-from-left-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-steel" />
        {who && <AgentAvatar name={who.name} color={who.color} avatar={who.avatar} size={20} />}
        <span><span className="font-semibold" style={by ? { color: tone(by.color) } : undefined}>{by?.name ?? "An agent"}</span> hired{" "}
          <span className="font-semibold">{ev.name}</span> as {ev.role}{ev.department ? <> in <span className="font-medium">{ev.department}</span></> : null}
          {ev.persisted === false && <span className="text-muted-foreground"> · run only</span>}</span>
      </div>
    );
  }
  return (
    <div className="ml-[46px] flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground animate-fade-up">
      <Settings2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-steel" />
      <span><span className="font-medium text-foreground">{by?.name ?? "Agent"}</span> {ev.self ? "refined its own configuration" : <>reconfigured <span className="font-medium text-foreground">{who?.name ?? ev.name}</span></>}: {ev.summary}
        {ev.reason ? <span className="italic"> · “{ev.reason}”</span> : null}</span>
    </div>
  );
}

function Rejected({ r, agents }: { r: Record<string, any>; agents: Record<string, AgentOut> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = agents[r.from_agent_id];
  return (
    <div className="ml-[46px] flex items-start gap-1.5 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-[11px] animate-fade-up">
      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <span><span className="font-medium">{a?.name}</span> → {r.to}: blocked. <span className="text-muted-foreground">{r.reason}</span></span>
    </div>
  );
}

export const KIND_ICON: Record<StepKind, LucideIcon> = {
  thought: Sparkles, read: FileCode2, write: Pencil, command: Terminal, browser: Monitor, task: ListTodo,
  team: UserPlus, review: Gavel, search: Search, other: Wrench,
};

/** A span as the feed shows it: "35m 26s", or "42s" under a minute. */
function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * One agent's steps between two messages. A header says how long the agent worked; then each thought, in full, is
 * followed by what it led to: file changes as one card, other actions as a list, in the order they ran.
 */
function StepRun({ steps, agents }: { steps: Step[]; agents: Record<string, AgentOut> }) {
  const a = agents[steps[0].agent_id];
  const failed = steps.filter((s) => s.status === "failed").length;
  const running = steps.some((s) => s.status === "running");
  const first = steps.find((s) => s.ts)?.ts;
  const last = steps[steps.length - 1]?.ts;
  const since = first ? parseUtc(first) : null;
  const span = since !== null && last ? parseUtc(last) - since : null;
  return (
    <div className="min-w-0 space-y-2.5 px-4 py-0.5 animate-fade-up text-[11px]" data-testid="step-run">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {a && <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={18} />}
        {a && <AgentName agent={a} className="font-medium" style={{ color: tone(a.color) }} />}
        {since !== null && running && <span>Worked for <Elapsed since={since} /></span>}
        {since !== null && !running && span !== null && span >= 1000 && <span>Worked for {formatSpan(span)}</span>}
        {failed > 0 && <span className="inline-flex items-center gap-1 text-destructive"><CircleX className="h-3 w-3" aria-hidden="true" />{failed} failed</span>}
      </div>
      {phasesOf(steps).map((phase) => <PhaseBlock key={phase.key} phase={phase} />)}
    </div>
  );
}

/** One thought as readable paragraphs, in plain text, then the steps that followed it. A heading line is its own paragraph. */
function PhaseBlock({ phase }: { phase: Phase }) {
  const text = (phase.thought?.detail ?? "").trim().replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "$1\n\n").replace(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm, "$1\n\n");
  const paragraphs = narrationParagraphs(text).join("\n\n");
  return (
    <div className="space-y-2">
      {phase.thought && <div className="text-[11px] leading-[1.45] text-foreground/90 [&_p+p]:mt-3"><Markdown>{paragraphs}</Markdown></div>}
      {segmentsOf(phase.steps).map((seg) => seg.kind === "files"
        ? <FileChanges key={seg.steps[0]!.id} steps={seg.steps} />
        : <ActionGroup key={seg.steps[0]!.id} steps={seg.steps} />)}
    </div>
  );
}
/** Open while its steps run, and closed once they finish. A reader can still open or close it. */
function useOpenWhileRunning(running: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = React.useState(running);
  React.useEffect(() => {
    if (!running) setOpen(false);
  }, [running]);
  return [open, setOpen];
}

/** The files a run of edits and writes changed: a summary with the file count and totals, then each file's lines added and removed. */
function FileChanges({ steps }: { steps: Step[] }) {
  const [all, setAll] = React.useState(false);
  const [open, setOpen] = useOpenWhileRunning(steps.some((s) => s.status === "running"));
  const files = fileTotals(steps);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const shown = all ? files : files.slice(0, 5);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group overflow-hidden rounded-xl border border-border bg-card text-[11px]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">Edited {files.length} file{files.length === 1 ? "" : "s"}</span>
        <span className="tabular-nums text-success">+{added}</span>
        <span className="tabular-nums text-destructive">-{removed}</span>
        <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-muted-foreground transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {shown.map((f) => (
          <li key={f.path} className="flex items-center gap-2 px-3 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{f.path}</span>
            <span className="tabular-nums text-success">+{f.added}</span>
            <span className="tabular-nums text-destructive">-{f.removed}</span>
          </li>
        ))}
      </ul>
      {files.length > 5 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full border-t border-border/60 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
          {all ? "Show fewer files" : `Show ${files.length - 5} more files`}
        </button>
      )}
    </details>
  );
}
/** The other actions one thought led to: a line saying what they did, then each action. Open while they run, closed once they finish. */
function ActionGroup({ steps }: { steps: Step[] }) {
  const Icon = KIND_ICON[steps[0]!.kind];
  const failed = steps.some((s) => s.status === "failed");
  const running = steps.some((s) => s.status === "running");
  const [open, setOpen] = useOpenWhileRunning(running);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{activitySummary(steps)}</span>
        {running && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" aria-label="a step is running" />}
        {failed && <CircleX className="h-3 w-3 shrink-0 text-destructive" aria-label="a step failed" />}
        <ChevronDown className="h-3 w-3 shrink-0 transition group-open:rotate-180" aria-hidden="true" />
      </summary>
      <ul className="mt-1.5 space-y-1 border-l border-border/60 pl-3.5">
        {steps.map((s) => <ActivityRow key={s.id} step={s} />)}
      </ul>
    </details>
  );
}
/** One action: its kind's icon and title. An action with output opens to show it. */
function ActivityRow({ step }: { step: Step }) {
  const Icon = KIND_ICON[step.kind];
  const failed = step.status === "failed";
  const output = step.detail.trim();
  const label = (
    <>
      <Icon className={cn("h-3 w-3 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden="true" />
      <span className={cn("min-w-0 flex-1 truncate text-foreground/85", failed && "text-destructive")}>{step.title}</span>
      {failed && <span className="shrink-0 text-[10px] text-destructive">failed</span>}
    </>
  );
  if (!output) return <li className="flex items-center gap-2">{label}</li>;
  return (
    <li>
      <details className="group/step">
        <summary className="flex cursor-pointer list-none items-center gap-2 hover:text-foreground">{label}</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/30 p-2 font-mono text-[10px]">{output}</pre>
      </details>
    </li>
  );
}


/** "· 1m 05s" since the agent's turn started: tells a long reasoning call apart from a run that is stuck. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => { const t = window.setInterval(tick, 1000); return () => window.clearInterval(t); }, []);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="tabular-nums text-[11px] text-muted-foreground" data-testid="turn-elapsed" title="Time since this turn started">
    {s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`}</span>;
}
