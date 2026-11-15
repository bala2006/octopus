import * as React from "react";
import { tone } from "@/lib/palette";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check, ChevronDown, Copy, Download, FileJson, MessageSquare, MessagesSquare, MoreHorizontal, Paperclip, Pencil, RefreshCw, Square, Trash2, Wrench,
  ArrowUp,
} from "lucide-react";
import { api, fetchRaw, unwrap } from "@/lib/api";
import { clockTime, cn, download, formatTokens, timeAgo } from "@/lib/utils";
import { useMoney } from "@/lib/money";
import { qk, useCanvas as useCanvasQuery, useCompanyId, useSessionMessages, useSessions, useWorkspaceId } from "@/hooks/queries";
import type { AgentOut, MessageOut, SessionOut } from "@/types";
import { AgentAvatar, ConnectionDot, EmptyState, TypingDots } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { PageToolbar, PromptComposer, SidePanel } from "@/components/ui/surfaces";
import { Badge, Input, Textarea } from "@/components/ui/primitives";
import {
  ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  Tip,
} from "@/components/ui/overlays";
import { AttachmentChips, useAttachments } from "./attachments";
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
    mutationFn: (body: { agent_id: string; title: string }) =>
      unwrap(api.POST("/api/v1/w/{workspace_id}/sessions", { params: { path: { workspace_id: w } }, body: { company_id: companyId, title: body.title, mode: "direct", agent_id: body.agent_id } })),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: qk.sessions(w, companyId) }); nav(`/w/${w}/chat/${s.id}`); },
    onError: (e: Error) => toast.error("Could not open chat", { description: e.message.includes("agent") ? "Save the canvas first (agents autosave within a second)." : e.message }),
  });

  const openAgent = React.useCallback((agentId: string) => {
    const existing = sessions.data?.find((s) => s.mode === "direct" && s.agent_id === agentId);
    if (existing) nav(`/w/${w}/chat/${existing.id}`);
    else createSession.mutate({ agent_id: agentId, title: `Chat with ${agents[agentId]?.name ?? "agent"}` });
  }, [sessions.data, agents, nav, w]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const a = params.get("agent");
    if (a && sessions.data && agents[a]) { setParams({}, { replace: true }); openAgent(a); }
  }, [params, sessions.data, agents, openAgent, setParams]);

  // Team conversations live in the Conversation space; this space is for one-on-one chats only.
  const direct = (sessions.data ?? []).filter((s) => s.mode === "direct");
  const session = direct.find((s) => s.id === sessionId);
  if (!companyId) return <EmptyState icon={MessageSquare} title="Create a team first" description="Direct chats are with the agents on your team." />;

  return (
    <div className="chat-layout flex h-full min-h-0">
      <ChatSidebar agents={canvas.data?.agents ?? []} sessions={direct} activeId={sessionId} onAgent={openAgent} />
      <div className="chat-main min-h-0 min-w-0 flex-1">
        {!sessionId ? (
          <EmptyState icon={MessagesSquare} title="Chat with one agent"
            description="Pick an agent on the left to ask a quick question or try its prompt. It answers alone, with its own tools and memory. To give the whole team work, use Conversation." />
        ) : !session ? (
          sessions.isLoading ? <div className="space-y-2 p-6">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14" />)}</div>
            : <EmptyState icon={MessagesSquare} title="This chat is not here" description="Team conversations open in Conversation. Pick an agent on the left to chat one-on-one." />
        ) : (
          <DirectChat key={session.id} session={session} agent={session.agent_id ? agents[session.agent_id] : undefined} />
        )}
      </div>
    </div>
  );
}

function ChatSidebar({ agents, sessions, activeId, onAgent }: {
  agents: AgentOut[]; sessions: SessionOut[]; activeId?: string; onAgent: (id: string) => void;
}) {
  const w = useWorkspaceId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [renaming, setRenaming] = React.useState<SessionOut | null>(null);
  const [deleting, setDeleting] = React.useState<SessionOut | null>(null);
  const [title, setTitle] = React.useState("");
  const active = sessions.find((s) => s.id === activeId);
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
    <SidePanel label="Direct chats" className="chat-sidebar h-full">
      <div id="chat-agents-heading" className="side-panel-header">Agents</div>
      <div className="chat-agents max-h-[45%] min-h-0 shrink-0 space-y-0.5 overflow-y-auto px-2 pb-2" role="list" aria-labelledby="chat-agents-heading" data-testid="chat-agents-list">
        {agents.map((a) => (
          <button key={a.id} onClick={() => onAgent(a.id)} data-testid={`chat-agent-${a.name}`} role="listitem"
            className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-accent", active?.agent_id === a.id && "bg-accent")}>
            <AgentAvatar name={a.name} color={a.color} avatar={a.avatar} size={24} />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{a.name}</span><span className="block truncate text-[10.5px] text-muted-foreground">{a.role}</span></span>
          </button>
        ))}
      </div>
      <div id="chat-history-heading" className="panel-heading shrink-0 border-t border-border">Earlier chats</div>
      <div className="chat-history min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2" role="list" aria-labelledby="chat-history-heading" data-testid="chat-history-list">
        {!sessions.length && <p className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet.</p>}
        {sessions.map((s) => (
          <div key={s.id} role="listitem" className={cn("group flex items-center gap-1 rounded-lg pr-1 transition hover:bg-accent/60", s.id === activeId && "bg-accent")}>
            <button onClick={() => nav(`/w/${w}/chat/${s.id}`)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center"><MessageSquare className="h-3.5 w-3.5 text-muted-foreground" /></span>
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
    </SidePanel>
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
      <PageToolbar actions={<ConnectionDot state={chat.conn} />}>
        <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} status={chat.streaming ? (chat.streaming.phase === "writing" ? "speaking" : chat.streaming.phase === "tool" ? "tool" : "thinking") : undefined} size={32} />
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-tight">{agent.name}</div>
          <div className="truncate text-xs leading-tight text-muted-foreground">{agent.role} &middot; <span className="font-mono">{agent.provider}/{agent.model}</span></div>
        </div>
      </PageToolbar>      <div className="min-h-0 flex-1 overflow-y-auto">
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
      <Composer placeholder={`Message ${agent.name}…`} busy={!!chat.streaming} onStop={chat.stop} onSend={(t, a) => chat.send(t, a)} />
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
          <div className="whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm">{meta.display ?? m.content}</div>
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
          {meta.warning && <Tip content={meta.warning}><Badge variant="warning">note</Badge></Tip>}
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

function Composer({ placeholder, busy, onSend, onStop, disabled, extra, images = false }: {
  placeholder: string; busy?: boolean; onSend: (text: string, att: import("@/types").ParsedFileOut[]) => void; onStop?: () => void; disabled?: boolean; extra?: React.ReactNode;
  /** accept pasted / attached images (they go to the agents as images) */
  images?: boolean;
}) {
  const [text, setText] = React.useState("");
  const att = useAttachments({ images });
  const [drag, setDrag] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { if (ref.current) { ref.current.style.height = "auto"; ref.current.style.height = `${Math.min(200, ref.current.scrollHeight)}px`; } }, [text]);
  const submit = () => {
    if ((!text.trim() && !att.files.length) || busy || disabled) return;
    onSend(text.trim(), att.files);
    setText("");
    att.clear();
  };
  return (
    <PromptComposer className={cn(drag && "is-dragging")}
      onDragOver={(event) => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
      onDrop={(event) => { event.preventDefault(); setDrag(false); if (event.dataTransfer.files.length) void att.upload(event.dataTransfer.files); }}
      caption={<><span>Enter to send</span><span className="ml-auto hidden sm:inline">Shift + Enter for a new line</span></>}
      controls={<>
        <Tip content={images ? "Attach an image or project file" : "Attach a text, PDF, or code file"}><Button variant="ghost" size="icon" onClick={att.pick} loading={att.uploading} aria-label="Attach file"><Paperclip /></Button></Tip>
        {att.input}{extra}<span className="flex-1" />
        {busy && onStop ? <Button size="icon" variant="secondary" className="composer-send" onClick={onStop} aria-label="Stop response"><Square className="fill-current" /></Button> : <Button size="icon" className="composer-send" onClick={submit} disabled={busy || (!text.trim() && !att.files.length) || disabled} aria-label="Send"><ArrowUp /></Button>}
      </>}>
      {att.files.length > 0 && <div className="mb-2"><AttachmentChips files={att.files} onRemove={att.remove} /></div>}
      <Textarea ref={ref} value={text} onChange={(event) => setText(event.target.value)} placeholder={placeholder} rows={2} disabled={disabled} onPaste={att.onPaste}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} aria-label="Message" data-testid="composer" />
    </PromptComposer>
  );
}
