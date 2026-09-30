import * as React from "react";
import { ArrowRight, Ban, Brain, ChevronDown, CircleCheck, CircleX, FileCode2, Gavel, Settings2, Sparkles, Terminal, User } from "lucide-react";
import { MESSAGE_TYPE_LABEL, statusMeta } from "@/lib/meta";
import { clockTime, cn } from "@/lib/utils";
import type { AgentOut, MessageOut } from "@/types";
import { AgentAvatar, StatusPill, TypingDots } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/primitives";
import type { OrgEvent, RunLive } from "./runState";

export type FeedFilter = "all" | "user" | "internal";

const TYPE_TONE: Record<string, string> = {
  proposal: "text-rose-400 border-rose-400/40", objection: "text-orange-400 border-orange-400/40", agreement: "text-emerald-400 border-emerald-400/40",
  decision: "text-amber-400 border-amber-400/40", critique: "text-orange-400 border-orange-400/40", review_request: "text-emerald-400 border-emerald-400/40",
  review_result: "text-emerald-400 border-emerald-400/40", task: "text-violet-400 border-violet-400/40", status_update: "text-sky-400 border-sky-400/40",
  final_report: "text-primary border-primary/50", question: "text-yellow-400 border-yellow-400/40", answer: "text-yellow-400 border-yellow-400/40",
  user_interjection: "text-primary border-primary/40",
};

export function isUserFacing(m: MessageOut): boolean {
  return m.sender === "user" || !m.to_agent_id || m.type === "final_report";
}

type Item = ({ kind: "msg"; m: MessageOut } | { kind: "files"; ms: MessageOut[] } | { kind: "rejected"; r: Record<string, any> } | { kind: "org"; ev: OrgEvent }) & { seq: number }; // eslint-disable-line @typescript-eslint/no-explicit-any

export function RunFeed({ state, agents, filter, showThoughts = true }: { state: RunLive; agents: Record<string, AgentOut>; filter: FeedFilter; showThoughts?: boolean }) {
  const bottom = React.useRef<HTMLDivElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const [stick, setStick] = React.useState(true);
  const items = React.useMemo(() => {
    const raw: Item[] = [];
    state.messages.forEach((m, i) => {
      if (filter === "user" && !isUserFacing(m)) return;
      if (filter === "internal" && (m.sender === "user" || !m.to_agent_id) && m.type !== "artifact_created") return;
      raw.push(m.type === "artifact_created" ? { kind: "files", ms: [m], seq: m._seq ?? i } : { kind: "msg", m, seq: m._seq ?? i });
    });
    if (filter !== "user") for (const r of state.rejected) raw.push({ kind: "rejected", r, seq: r.seq ?? 0 });
    for (const ev of state.orgEvents) raw.push({ kind: "org", ev, seq: ev.seq });
    raw.sort((a, b) => a.seq - b.seq);
    const out: Item[] = [];
    for (const it of raw) { // group consecutive file writes by the same agent
      const last = out[out.length - 1];
      if (it.kind === "files" && last?.kind === "files" && last.ms[0].from_agent_id === it.ms[0].from_agent_id) last.ms.push(...it.ms);
      else out.push(it.kind === "files" ? { ...it, ms: [...it.ms] } : it);
    }
    return out;
  }, [state.messages, state.rejected, state.orgEvents, filter]);
  const active = Object.entries(state.agentStatus).filter(([, st]) => statusMeta(st).live);

  React.useEffect(() => { if (stick) bottom.current?.scrollIntoView({ block: "end" }); }, [items.length, stick, state.streaming]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <div className="relative h-full">
      <div ref={scroller} onScroll={onScroll} className="h-full space-y-1 overflow-y-auto px-3 py-3" role="log" aria-live="polite" aria-label="Run feed">
        {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Waiting for the first message…</p>}
        {items.map((it) => it.kind === "msg" ? <FeedMessage key={it.m.id} m={it.m} agents={agents} />
          : it.kind === "files" ? <FileGroup key={it.ms[0].id} ms={it.ms} agents={agents} />
          : it.kind === "org" ? <OrgItem key={`o${it.seq}`} ev={it.ev} agents={agents} />
          : <Rejected key={`r${it.seq}`} r={it.r} agents={agents} />)}
        {active.map(([aid, st]) => {
          const a = agents[aid];
          if (!a) return null;
          return (
            <div key={`live-${aid}`} className="flex gap-2.5 rounded-lg px-2 py-2 animate-fade-up">
              <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} status={st} size={28} />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 text-xs"><span className="font-semibold">{a.name}</span><StatusPill status={st} activity={state.activity[aid]} /></div>
                {showThoughts && state.thoughts[aid] && <p className="flex items-start gap-1 text-[11px] italic text-muted-foreground"><Brain className="mt-0.5 h-3 w-3 shrink-0" />{state.thoughts[aid]}</p>}
                {state.streaming[aid] ? (
                  <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-[10.5px] leading-snug text-muted-foreground [mask-image:linear-gradient(to_bottom,transparent,black_30%)]">
                    {state.streaming[aid].slice(-600)}
                  </pre>
                ) : <TypingDots color={statusMeta(st).color} />}
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
  );
}

function FeedMessage({ m, agents }: { m: MessageOut; agents: Record<string, AgentOut> }) {
  const from = m.from_agent_id ? agents[m.from_agent_id] : null;
  const to = m.to_agent_id ? agents[m.to_agent_id] : null;
  const [open, setOpen] = React.useState(m.content.length < 700 || m.type === "final_report");
  const meta = (m.meta ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const isUser = m.sender === "user";
  const verdict = meta.verdict as string | undefined;
  return (
    <article className={cn("group rounded-lg px-2 py-2 transition-colors animate-fade-up hover:bg-accent/30", m.type === "final_report" && "border border-primary/30 bg-primary/5",
      isUser && "bg-primary/[0.04]")} aria-label={`${from?.name ?? "You"} to ${to?.name ?? "you"}`}>
      <div className="flex gap-2.5">
        {from ? <AgentAvatar name={from.name} color={from.color} avatar={from.avatar} size={28} /> :
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary"><User className="h-3.5 w-3.5" /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold" style={from ? { color: from.color } : undefined}>{from?.name ?? "You"}</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <span className="font-medium text-muted-foreground">{to?.name ?? (m.type === "final_report" || m.type === "question" ? "You" : "Everyone")}</span>
            <span className={cn("rounded border px-1.5 py-px text-[10px] font-medium", TYPE_TONE[m.type] ?? "text-muted-foreground border-border")}>{MESSAGE_TYPE_LABEL[m.type] ?? m.type}</span>
            {verdict && (verdict === "approve" ? <Badge variant="success"><CircleCheck className="h-3 w-3" />approved</Badge> : <Badge variant="warning"><CircleX className="h-3 w-3" />changes requested</Badge>)}
            {meta.debate && <Badge variant="outline"><Gavel className="h-3 w-3" />round {meta.debate.round}/{meta.debate.max_rounds}{meta.debate.status !== "open" ? ` · ${meta.debate.status}` : ""}</Badge>}
            {meta.review && <Badge variant="outline">rev {meta.review.revisions}/{meta.review.max_revisions}</Badge>}
            {meta.task_id && <Badge variant="secondary">{meta.task_id}</Badge>}
            {meta.awaiting_input && <Badge variant="warning">asks you</Badge>}
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground opacity-0 transition group-hover:opacity-100">t{m.turn_no} · {clockTime(m.created_at)}</span>
          </div>
          <div className={cn("relative mt-1 text-[13px]", !open && "max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
            <Markdown>{m.content}</Markdown>
          </div>
          {m.content.length >= 700 && m.type !== "final_report" && (
            <button onClick={() => setOpen(!open)} className="mt-0.5 text-[11px] font-medium text-primary hover:underline">{open ? "Show less" : "Show more"}</button>
          )}
        </div>
      </div>
    </article>
  );
}

function FileGroup({ ms, agents }: { ms: MessageOut[]; agents: Record<string, AgentOut> }) {
  const a = ms[0].from_agent_id ? agents[ms[0].from_agent_id] : null;
  return (
    <div className="ml-9 flex flex-wrap items-center gap-1.5 rounded-md py-1 text-[11px] text-muted-foreground animate-fade-up">
      <FileCode2 className="h-3.5 w-3.5 text-emerald-400" />
      <span style={a ? { color: a.color } : undefined} className="font-medium">{a?.name}</span>
      {ms.map((m) => (
        <span key={m.id} className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono">
          {(m.meta?.planned ? "📝 " : "") + String(m.meta?.path ?? "")}<span className="text-muted-foreground/70"> v{String(m.meta?.version ?? "")}</span>
        </span>
      ))}
    </div>
  );
}

function OrgItem({ ev, agents }: { ev: OrgEvent; agents: Record<string, AgentOut> }) {
  const by = agents[ev.by];
  const who = agents[ev.agent_id];
  if (ev.kind === "created") {
    return (
      <div className="ml-9 flex items-center gap-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/5 px-2.5 py-2 text-xs animate-in fade-in-0 slide-in-from-left-2">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-fuchsia-400" />
        {who && <AgentAvatar name={who.name} color={who.color} avatar={who.avatar} size={20} />}
        <span><span className="font-semibold" style={by ? { color: by.color } : undefined}>{by?.name ?? "An agent"}</span> hired{" "}
          <span className="font-semibold">{ev.name}</span> as {ev.role}{ev.department ? <> in <span className="font-medium">{ev.department}</span></> : null}
          {ev.persisted === false && <span className="text-muted-foreground"> · run only</span>}</span>
      </div>
    );
  }
  return (
    <div className="ml-9 flex items-start gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground animate-fade-up">
      <Settings2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-400" />
      <span><span className="font-medium text-foreground">{by?.name ?? "Agent"}</span> {ev.self ? "refined its own configuration" : <>reconfigured <span className="font-medium text-foreground">{who?.name ?? ev.name}</span></>}: {ev.summary}
        {ev.reason ? <span className="italic"> · “{ev.reason}”</span> : null}</span>
    </div>
  );
}

function Rejected({ r, agents }: { r: Record<string, any>; agents: Record<string, AgentOut> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = agents[r.from_agent_id];
  return (
    <div className="ml-9 flex items-start gap-1.5 rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-[11px] animate-fade-up">
      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <span><span className="font-medium">{a?.name}</span> → {r.to}: blocked. <span className="text-muted-foreground">{r.reason}</span></span>
    </div>
  );
}

export function ToolLog({ state, agents }: { state: RunLive; agents: Record<string, AgentOut> }) {
  const calls = Object.values(state.toolCalls).sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  return (
    <div className="space-y-1.5 p-3">
      {!calls.length && <p className="py-8 text-center text-sm text-muted-foreground">No tool calls yet.</p>}
      {calls.map((c) => (
        <details key={c.call_id} className="group rounded-lg border border-border text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5">
            {c.ok === undefined ? <span className="h-2 w-2 animate-pulse rounded-full bg-warning" /> : c.ok ? <CircleCheck className="h-3.5 w-3.5 text-success" /> : <CircleX className="h-3.5 w-3.5 text-destructive" />}
            {c.tool === "run_code" && <Terminal className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="font-mono font-medium">{c.tool}</span>
            <span className="truncate text-muted-foreground">{String(c.args?.path ?? c.args?.command ?? c.args?.tool ?? c.args?.query ?? "")}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{agents[c.agent_id]?.name}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition group-open:rotate-180" />
          </summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border bg-muted/30 p-2.5 font-mono text-[11px]">{c.output ?? JSON.stringify(c.args, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
