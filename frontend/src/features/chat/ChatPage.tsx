import * as React from "react";
import { tone } from "@/lib/palette";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2, Check, ChevronDown, Copy, Download, FileJson, Hash, MessageSquare, MoreHorizontal, Pencil, RefreshCw, Trash2, Wrench,
  Play, Radio,
} from "lucide-react";
import { api, fetchRaw, unwrap } from "@/lib/api";
import { clockTime, cn, download, formatTokens, timeAgo } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { qk, useCanvas as useCanvasQuery, useCompanyId, useRuns, useSessionMessages, useSessions, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { AgentOut, MessageOut, SessionOut } from "@/types";
import { AgentAvatar, ConnectionDot, EmptyState, TypingDots } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";
import {
  ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Select, Tip,
} from "@/components/ui/overlays";
import { RunFeed, type FeedFilter } from "@/features/runs/RunFeed";
import { RunDialog } from "@/features/runs/RunDialog";
import { QuestionCard } from "@/features/runs/QuestionCard";
import { ApprovalCard } from "@/features/runs/ApprovalCard";
import { useRunStream } from "@/features/runs/useRunStream";
import { TERMINAL } from "@/features/runs/runState";
import { AttachmentChips } from "./attachments";
import { Composer } from "@/components/Composer";
import { sendToRun } from "@/features/runs/sendToRun";
import { ResizeHandle, usePanelWidth } from "@/components/ResizeHandle";
import { MessageImages } from "@/features/runs/MessageImages";
import { useDirectChat, type StreamingMsg } from "./useDirectChat";

export default function ChatPage() {
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const { sessionId } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const canvas = useCanvasQuery(w, companyId);
  const sessions = useSessions(w, companyId);
  const agents = React.useMemo(() => Object.fromEntries((canvas.data?.agents ?? []).map((a) => [a.id, a])), [canvas.data]);

  const createSession = useMutation({
    mutationFn: (body: { mode: "direct" | "company"; agent_id?: string; title?: string }) =>
      unwrap(api.POST("/api/v1/w/{workspace_id}/sessions", { params: { path: { workspace_id: w } }, body: { company_id: companyId, title: body.title ?? "New chat", mode: body.mode, agent_id: body.agent_id } })),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: qk.sessions(w, companyId) }); nav(`/w/${w}/chat/${s.id}`); },
    onError: (e: Error) => toast.error("Could not open chat", { description: e.message.includes("agent") ? "Save the canvas first (agents autosave within a second)." : e.message }),
  });

  const openAgent = React.useCallback((agentId: string) => {
    const existing = sessions.data?.find((s) => s.mode === "direct" && s.agent_id === agentId);
    if (existing) nav(`/w/${w}/chat/${existing.id}`);
    else createSession.mutate({ mode: "direct", agent_id: agentId, title: `Chat with ${agents[agentId]?.name ?? "agent"}` });
  }, [sessions.data, agents, nav, w]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const a = params.get("agent");
    if (a && sessions.data && agents[a]) { setParams({}, { replace: true }); openAgent(a); }
  }, [params, sessions.data, agents, openAgent, setParams]);

  const session = sessions.data?.find((s) => s.id === sessionId);
  if (!companyId) return <EmptyState icon={MessageSquare} title="Create a company first" description="Chats belong to a company of agents." />;

  return (
    <div className="flex h-full">
      <ChatSidebar agents={canvas.data?.agents ?? []} sessions={sessions.data ?? []} activeId={sessionId} onAgent={openAgent}
        onCompany={() => { const s = sessions.data?.find((x) => x.mode === "company"); if (s) nav(`/w/${w}/chat/${s.id}`); else createSession.mutate({ mode: "company", title: "Company channel" }); }} />
      <div className="min-w-0 flex-1">
        {!sessionId ? (
          <EmptyState icon={MessageSquare} title="Talk to your company"
            description="Pick an agent for a direct conversation, or open the Company Channel to give the whole team a goal."
            action={<Button onClick={() => createSession.mutate({ mode: "company", title: "Company channel" })}><Building2 />Open Company Channel</Button>} />
        ) : !session ? (
          <div className="space-y-2 p-6">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}</div>
        ) : session.mode === "direct" ? (
          <DirectChat key={session.id} session={session} agent={session.agent_id ? agents[session.agent_id] : undefined} />
        ) : (
          <CompanyChat key={session.id} session={session} agents={agents} companyId={companyId} />
        )}
      </div>
    </div>
  );
}

/** One section rhythm for both sidebar headings (they used to differ: pt-2 vs mt-3). */
function SidebarHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <div id={id} className="shrink-0 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

const CHAT_SIDEBAR_MAX = () => Math.max(260, Math.round(window.innerWidth * 0.45));

function ChatSidebar({ agents, sessions, activeId, onAgent, onCompany }: {
  agents: AgentOut[]; sessions: SessionOut[]; activeId?: string; onAgent: (id: string) => void; onCompany: () => void;
}) {
  const w = useWorkspaceId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [renaming, setRenaming] = React.useState<SessionOut | null>(null);
  const [deleting, setDeleting] = React.useState<SessionOut | null>(null);
  const [title, setTitle] = React.useState("");
  const active = sessions.find((s) => s.id === activeId);
  const panel = usePanelWidth("chat-sidebar", 256, 200, CHAT_SIDEBAR_MAX);
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/w/{workspace_id}/sessions/{session_id}", { params: { path: { workspace_id: w, session_id: renaming!.id } }, body: { title } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["sessions"] }); setRenaming(null); },
  });
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/w/{workspace_id}/sessions/{session_id}", { params: { path: { workspace_id: w, session_id: id } } })),
    onSuccess: (_d, id) => { qc.invalidateQueries({ queryKey: ["sessions"] }); if (id === activeId) nav(`/w/${w}/chat`); toast.success("Chat deleted"); },
  });
  const exportAs = async (s: SessionOut, format: "json" | "md") => {
    const res = await fetchRaw(`/api/v1/w/${w}/sessions/${s.id}/export?format=${format}`);
    download(`${s.title.replace(/\W+/g, "-").slice(0, 40) || "chat"}.${format}`, await res.text(), format === "json" ? "application/json" : "text/markdown");
  };

  return (
    // Bounded flex column: Agents takes its natural height up to 45% and scrolls beyond that; History gets the rest and
    // scrolls too. (Agents used to be unbounded, so with ~8+ agents History collapsed to zero height and never scrolled.)
    <>
    <aside className="flex h-full min-h-0 shrink-0 flex-col border-r border-border bg-surface" style={{ width: panel.width }} aria-label="Chats">
      <div className="shrink-0 p-2">
        <button onClick={onCompany} className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium transition hover:bg-accent", active?.mode === "company" && "bg-accent")}>
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-steel to-steel text-white"><Hash className="h-4 w-4" /></span>
          Company Channel
        </button>
      </div>
      <SidebarHeading id="chat-agents-heading">Agents</SidebarHeading>
      <div className="max-h-[45%] min-h-0 shrink-0 space-y-0.5 overflow-y-auto px-2 pb-2" role="list" aria-labelledby="chat-agents-heading" data-testid="chat-agents-list">
        {agents.map((a) => (
          <button key={a.id} onClick={() => onAgent(a.id)} data-testid={`chat-agent-${a.name}`} role="listitem"
            className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent", active?.agent_id === a.id && "bg-accent")}>
            <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={24} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{a.name}</span><span className="block truncate text-[10.5px] text-muted-foreground">{a.role}</span></span>
          </button>
        ))}
      </div>
      <SidebarHeading id="chat-history-heading">History</SidebarHeading>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2" role="list" aria-labelledby="chat-history-heading" data-testid="chat-history-list">
        {!sessions.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet.</p>}
        {sessions.map((s) => (
          <div key={s.id} role="listitem" className={cn("group flex items-center gap-1 rounded-lg pr-1 transition hover:bg-accent/60", s.id === activeId && "bg-accent")}>
            <button onClick={() => nav(`/w/${w}/chat/${s.id}`)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center">{s.mode === "company" ? <Hash className="h-3.5 w-3.5 text-muted-foreground" /> : <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-xs">{s.title}</span><span className="text-[10px] text-muted-foreground">{timeAgo(s.created_at)}</span></span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button className="rounded p-1 opacity-0 transition hover:bg-background focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Chat options"><MoreHorizontal className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => { setTitle(s.title); setRenaming(s); }}><Pencil />Rename</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportAs(s, "md")}><Download />Export Markdown</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportAs(s, "json")}><FileJson />Export JSON</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => setDeleting(s)}><Trash2 />Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Rename chat</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); rename.mutate(); }} className="space-y-3"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="flex justify-end"><Button type="submit" loading={rename.isPending}>Save</Button></div></form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.title}"?`} destructive confirmLabel="Delete"
        description="This removes the conversation history." onConfirm={() => deleting && del.mutate(deleting.id)} />
    </aside>
    <ResizeHandle side="left" label="Resize the chat list" width={panel.width} onResize={panel.set} onReset={panel.reset} min={panel.min} max={panel.max()} className="-ml-1.5" />
    </>
  );
}

// ---------------------------------------------------------------- direct chat
function DirectChat({ session, agent }: { session: SessionOut; agent?: AgentOut }) {
  const w = useWorkspaceId();
  const msgs = useSessionMessages(w, session.id);
  const chat = useDirectChat(w, session.id);
  const bottom = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs.data?.length, chat.streaming?.text]);
  if (!agent) return <EmptyState icon={MessageSquare} title="This agent no longer exists" />;
  const last = msgs.data?.[msgs.data.length - 1];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} status={chat.streaming ? (chat.streaming.phase === "writing" ? "speaking" : chat.streaming.phase === "tool" ? "tool" : "thinking") : undefined} size={32} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{agent.name}</div>
          <div className="text-xs text-muted-foreground">{agent.role} · <span className="font-mono">{agent.provider}/{agent.model}</span></div>
        </div>
        <ConnectionDot state={chat.conn} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
          {msgs.isLoading && [0, 1].map((i) => <div key={i} className="skeleton h-16" />)}
          {msgs.data?.length === 0 && !chat.streaming && (
            <div className="py-10 text-center animate-fade-up">
              <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} size={48} className="mx-auto" />
              <p className="mt-3 text-sm font-medium">Chat with {agent.name}</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{agent.description || `Uses ${agent.name}'s system prompt, model and long-term memory.`}</p>
            </div>
          )}
          {msgs.data?.map((m) => <ChatMessage key={m.id} m={m} agent={agent} isLast={m.id === last?.id} onRegenerate={chat.regenerate} busy={!!chat.streaming} />)}
          {chat.streaming && <StreamingMessage s={chat.streaming} agent={agent} />}
          <div ref={bottom} />
        </div>
      </div>
      <Composer className="mx-auto w-full max-w-3xl" placeholder={`Message ${agent.name}…`} busy={!!chat.streaming} onStop={chat.stop}
        onSend={(p) => chat.send(p.text, p.files, p.images)} />
    </div>
  );
}

function ChatMessage({ m, agent, isLast, onRegenerate, busy }: { m: MessageOut; agent: AgentOut; isLast: boolean; onRegenerate: () => void; busy: boolean }) {
  const money = useMoney();
  const [copied, setCopied] = React.useState(false);
  const meta = (m.meta ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (m.sender === "user") {
    return (
      <div className="flex justify-end animate-fade-up">
        <div className="max-w-[80%] space-y-1">
          {meta.attachments?.length > 0 && <AttachmentChips files={meta.attachments.map((a: { filename: string; chars: number }) => ({ filename: a.filename, chars: a.chars, text: "", truncated: false }))} />}
          {meta.images?.length > 0 && <MessageImages align="end" images={(meta.images as { name: string; data_url: string }[]).map((i) => ({ name: i.name, src: i.data_url }))} />}
          {(meta.display ?? m.content) && <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm">{meta.display ?? m.content}</div>}
          <div className="text-right text-[10px] text-muted-foreground">{clockTime(m.created_at)}</div>
        </div>
      </div>
    );
  }
  const copy = async () => { await navigator.clipboard.writeText(m.content); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <div className="group flex gap-3 animate-fade-up">
      <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} size={30} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold" style={{ color: tone(agent.color) }}>{agent.name}</span>
          <span className="text-muted-foreground">{agent.role}</span>
          <span className="font-mono text-[10px] text-muted-foreground">{meta.provider}/{meta.model}</span>
          {meta.warning && <Tip content={meta.warning}><Badge variant="warning">demo</Badge></Tip>}
          {meta.stopped && <Badge variant="outline">stopped</Badge>}
        </div>
        {meta.tool_calls?.length > 0 && <ToolCalls calls={meta.tool_calls} />}
        <Markdown>{m.content}</Markdown>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground opacity-0 transition group-hover:opacity-100">
          <span>{clockTime(m.created_at)}</span>
          {meta.tokens ? (
            <Tip content={meta.usage ? `Input ${meta.usage.input_tokens} (cached ${meta.usage.cached_tokens}, cache writes ${meta.usage.cache_write_tokens}) · Output ${meta.usage.output_tokens} (reasoning ${meta.usage.reasoning_tokens})` : "Tokens"}>
              <span>{formatTokens(meta.tokens)} tokens{meta.cost_usd ? ` · ${money(meta.cost_usd)}` : ""}</span>
            </Tip>
          ) : null}
          {meta.duration_ms ? <span>{(meta.duration_ms / 1000).toFixed(1)}s</span> : null}
          <button onClick={copy} className="flex items-center gap-0.5 rounded px-1 hover:bg-accent hover:text-foreground" aria-label="Copy message">{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}Copy</button>
          {isLast && !busy && <button onClick={onRegenerate} className="flex items-center gap-0.5 rounded px-1 hover:bg-accent hover:text-foreground"><RefreshCw className="h-3 w-3" />Regenerate</button>}
        </div>
      </div>
    </div>
  );
}

function ToolCalls({ calls }: { calls: Array<{ name: string; args: unknown; result?: string }> }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border border-border text-xs">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground hover:text-foreground" aria-expanded={open}>
        <Wrench className="h-3.5 w-3.5" />{calls.length} tool call{calls.length > 1 ? "s" : ""}: {calls.map((c) => c.name).join(", ")}
        <ChevronDown className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && calls.map((c, i) => (
        <div key={i} className="border-t border-border bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] animate-fade-up">
          <div>{c.name}({JSON.stringify(c.args)})</div>{c.result !== undefined && <div className="text-success">→ {c.result}</div>}
        </div>
      ))}
    </div>
  );
}

function StreamingMessage({ s, agent }: { s: StreamingMsg; agent: AgentOut }) {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => { const t = setInterval(() => setElapsed(Date.now() - s.startedAt), 250); return () => clearInterval(t); }, [s.startedAt]);
  return (
    <div className="flex gap-3" aria-live="polite" aria-busy>
      <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} status={s.phase === "writing" ? "speaking" : s.phase === "tool" ? "tool" : "thinking"} size={30} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold" style={{ color: tone(agent.color) }}>{agent.name}</span>
          <span className="shimmer-text font-medium">{s.detail}</span>
          <span className="tabular-nums text-[10px] text-muted-foreground">{(elapsed / 1000).toFixed(1)}s</span>
        </div>
        {s.tools.length > 0 && <ToolCalls calls={s.tools} />}
        {s.text ? <Markdown streaming>{s.text}</Markdown> : <TypingDots color={agent.color} className="mt-2" />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- company chat
function CompanyChat({ session, agents, companyId }: { session: SessionOut; agents: Record<string, AgentOut>; companyId: string }) {
  const w = useWorkspaceId();
  const runs = useRuns(w, companyId, true);
  const sessionRuns = (runs.data ?? []).filter((r) => r.session_id === session.id);
  const liveRun = sessionRuns.find((r) => !TERMINAL.has(r.status));
  const shownRun = liveRun ?? sessionRuns[0];
  const names = React.useMemo(() => Object.fromEntries(Object.values(agents).map((a) => [a.id, a.name])), [agents]);
  const stream = useRunStream(w, shownRun?.id, names);
  const filter = useApp((s) => s.chatFilter);
  const setFilter = useApp((s) => s.setChatFilter);
  const [goal, setGoal] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState("all");
  const nav = useNavigate();
  const live = !!liveRun && !TERMINAL.has(stream.state.status);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-steel to-steel text-white"><Hash className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Company Channel</div>
          <div className="truncate text-xs text-muted-foreground">{shownRun ? `${live ? "Live" : "Finished, send a message to continue"}: ${shownRun.goal}` : "Send a goal to the entry agent(s); watch the team work"}</div>
        </div>
        {sessionRuns.length > 1 && <span className="text-[11px] text-muted-foreground">{sessionRuns.length} runs</span>}
        <Select ariaLabel="Feed filter" value={filter} onValueChange={(v) => setFilter(v as FeedFilter)} className="h-7 w-[150px] text-xs"
          options={[{ value: "all", label: "All messages" }, { value: "user", label: "User-facing only" }, { value: "internal", label: "Internal only" }]} />
        {shownRun && !live && <Tip content="Start over with a new goal (the current run and its history stay in Runs)"><Button size="sm" variant="ghost" onClick={() => setGoal("")}><Play />New run</Button></Tip>}
        {shownRun && <Button size="sm" variant="secondary" onClick={() => nav(`/w/${w}/runs/${shownRun.id}`)}><Radio className={cn(live && "animate-pulse text-primary")} />Live view</Button>}
      </div>
      <div className="min-h-0 flex-1">
        {shownRun ? <RunFeed state={stream.state} agents={agents} filter={filter} /> : (
          <EmptyState icon={Building2} title="No runs in this channel yet" description='Type a goal below, e.g. "Build a todo app with auth", and press Run.' />
        )}
      </div>
      {live && stream.state.awaiting && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2">
          <QuestionCard key={stream.state.awaiting.question} awaiting={stream.state.awaiting} agent={agents[stream.state.awaiting.agent_id]}
            onAnswer={(answer) => stream.send({ type: "interject", content: answer, to_agent_id: stream.state.awaiting!.agent_id })} />
        </div>
      )}
      {live && stream.state.pendingApproval && (
        <div className="mx-auto w-full max-w-3xl px-3 pb-2">
          <ApprovalCard key={stream.state.pendingApproval.id} approval={stream.state.pendingApproval} agent={agents[stream.state.pendingApproval.agent_id]}
            onDecide={(ok, scope, reason) => stream.send({ type: ok ? "approve" : "reject", approval_id: stream.state.pendingApproval!.id, scope, reason })} />
        </div>
      )}
      <Composer className="mx-auto w-full max-w-3xl"
        placeholder={live ? "Interject: your message is injected into the run…" : shownRun ? "Continue: ask for changes or the next step. The team keeps its context and files…" : "Give the company a goal…"}
        onSend={(p) => {
          // a finished run continues like a chat (same run, history and files); "New run" starts over explicitly
          if (shownRun) void sendToRun(w, shownRun.id, p, target === "all" ? undefined : target, stream.send);
          else setGoal(p.text);
        }}
        extra={shownRun ? (
          <Select ariaLabel="Send to" value={target} onValueChange={setTarget} className="h-7 w-[130px] text-xs"
            options={[{ value: "all", label: live ? "Everyone" : "Entry agent" }, ...Object.values(agents).map((a) => ({ value: a.id, label: a.name }))]} />
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Play className="h-3 w-3" />starts a run</span>
        )}
      />
      <RunDialog open={goal !== null} onOpenChange={(o) => !o && setGoal(null)} companyId={companyId} sessionId={session.id} initialGoal={goal ?? ""}
        onStarted={() => { setGoal(null); void runs.refetch(); }} />
    </div>
  );
}

