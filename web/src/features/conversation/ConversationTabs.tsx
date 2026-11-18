import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, ClipboardCheck, Code2, FileCode2, Gauge, GitBranch, Globe, MessageSquare, Network, Plus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileTotal } from "@/features/runs/steps";
import type { AgentOut } from "@/types";
import { AgentAvatar } from "@/components/common";

export type TabKind = "chat" | "canvas" | "changes" | "browser" | "review" | "code" | "git" | "usage" | "agent" | "new";
export interface ConversationTab {
  id: string;
  kind: TabKind;
  /** For an agent tab: the agent whose chat it holds, and its name for the label. */
  agentId?: string;
  title?: string;
}

const LABEL: Record<TabKind, string> = { chat: "Chat", canvas: "Canvas", changes: "Changes", browser: "Browser", review: "Review", code: "Files", git: "Git changes", usage: "Usage", agent: "Agent", new: "New tab" };
const ICON: Record<TabKind, LucideIcon> = { chat: MessageSquare, canvas: Network, changes: FileCode2, browser: Globe, review: ClipboardCheck, code: Code2, git: GitBranch, usage: Gauge, agent: MessageSquare, new: Globe };

/** The changed files of the last turn: a title, the count with its totals, then each file with its lines added and removed. */
export function ChangesSummary({ changes }: { changes: FileTotal[] }) {
  const added = changes.reduce((n, f) => n + f.added, 0);
  const removed = changes.reduce((n, f) => n + f.removed, 0);
  return (
    <div>
      <p className="text-[13px] font-semibold">Changes</p>
      <p className="text-[12px] text-muted-foreground">Last turn</p>
      {changes.length ? (
        <>
          <div className="mt-3 flex items-center justify-between text-[12px] text-muted-foreground">
            <span>{changes.length} changed file{changes.length === 1 ? "" : "s"}</span>
            <span className="tabular-nums">
              <span className="text-success">+{added}</span> <span className="text-destructive">-{removed}</span>
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {changes.map((file) => {
              const slash = file.path.lastIndexOf("/");
              return (
                <li key={file.path} className="conversation-change-row">
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="conversation-change-path">
                    <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
                    {file.path.slice(slash + 1)}
                  </span>
                  <span className="tabular-nums text-success">+{file.added}</span>
                  <span className="tabular-nums text-destructive">-{file.removed}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-[12px] text-muted-foreground">No files changed in the last turn.</p>
      )}
    </div>
  );
}

/** One circular arrow at an edge of the tab bar. It is shown only while tabs are hidden on that side. */
function ScrollButton({ direction, onClick }: { direction: "left" | "right"; onClick: () => void }) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  const label = `Scroll tabs ${direction}`;
  return (
    <button type="button" aria-label={label} title={label} className="conversation-tabs-scroll" onClick={onClick}>
      <Icon aria-hidden="true" />
    </button>
  );
}

/**
 * The conversation's tab bar. The chat is the home tab: an icon, and it cannot close. The active tab has a box and its
 * close button. Dividers separate the other tabs. When the tabs are wider than the bar, a circular arrow at each edge
 * scrolls them, and the selected tab scrolls into view. Changes previews its summary when hovered.
 */
export function ConversationTabs({
  tabs,
  activeId,
  changes,
  onSelect,
  onClose,
  onNew,
  onMove,
  actions,
}: {
  tabs: ConversationTab[];
  activeId: string;
  changes: FileTotal[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onMove: (id: string, index: number) => void;
  actions?: ReactNode;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [preview, setPreview] = useState<DOMRect | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const track = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, tabs]);

  useEffect(() => {
    track.current?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const scrollTabs = (direction: -1 | 1) => track.current?.scrollBy({ left: direction * 160, behavior: "smooth" });

  return (
    <nav className="conversation-tabs" aria-label="Conversation tabs">
      {edges.left && <ScrollButton direction="left" onClick={() => scrollTabs(-1)} />}
      <div ref={track} className="conversation-tabs-track" onScroll={() => { measure(); setPreview(null); }}>
        {tabs.map((tab, index) => {
          const Icon = ICON[tab.kind];
          const label = tab.kind === "agent" && tab.title ? tab.title : LABEL[tab.kind];
          const selected = tab.id === activeId;
          const divided = index > 1 && !selected && tabs[index - 1]?.id !== activeId;
          return (
            <div key={tab.id} className={cn("conversation-tab-item", divided && "is-divided", selected && "is-selected", dragging === tab.id && "is-dragging")} draggable={tab.kind !== "chat"} onDragStart={(e) => { e.dataTransfer.setData("text/plain", tab.id); setDragging(tab.id); }} onDragOver={(e) => { if (dragging) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); if (dragging && dragging !== tab.id) onMove(dragging, index); setDragging(null); }} onDragEnd={() => setDragging(null)} onMouseEnter={tab.kind === "changes" ? (e) => setPreview(e.currentTarget.getBoundingClientRect()) : undefined} onMouseLeave={() => setPreview(null)}>
              <button type="button" role="tab" aria-selected={selected} aria-label={label} title={label} className="conversation-tab" onClick={() => onSelect(tab.id)}>
                <Icon aria-hidden="true" />
                {tab.kind !== "chat" && label}
              </button>
              {tab.kind !== "chat" && (
                <button type="button" aria-label={`Close ${label}`} className="conversation-tab-close" onClick={() => onClose(tab.id)}>
                  <X aria-hidden="true" />
                </button>
              )}
              {tab.kind === "changes" && preview && createPortal(
                <div className="conversation-tab-preview" role="tooltip" style={{ top: preview.bottom + 8, left: preview.left }}>
                  <ChangesSummary changes={changes} />
                </div>,
                document.body,
              )}
            </div>
          );
        })}
      </div>
      {edges.right && <ScrollButton direction="right" onClick={() => scrollTabs(1)} />}
      <button type="button" aria-label="New tab" title="New tab" className="conversation-tab-new" onClick={onNew}>
        <Plus aria-hidden="true" />
      </button>
      {actions && <div className="conversation-tabs-actions">{actions}</div>}
    </nav>
  );
}

const CHOICES: { kind: Exclude<TabKind, "new">; title: string; detail: string }[] = [
  { kind: "canvas", title: "Canvas", detail: "The team and what each agent is doing, with the chat floating over it." },
  { kind: "changes", title: "Changes", detail: "The files this conversation has changed." },
  { kind: "browser", title: "Browser", detail: "Each step the team took in its browser, with a screenshot of what it saw." },
  { kind: "review", title: "Review", detail: "Each review round, with the specialists' verdicts and findings." },
  { kind: "code", title: "Files", detail: "Edit the project's files, run commands and preview the app." },
  { kind: "git", title: "Git changes", detail: "Changed files in this project. Review each diff, stage what you want, and commit." },
  { kind: "usage", title: "Usage", detail: "Tokens, cost and tool calls for this conversation." },
  { kind: "chat", title: "Chat", detail: "The full conversation." },
];

/** A new tab: pick the view it should show. */
/** A new tab: pick the view it should show, or the agent whose chat it should hold. Anything already open is left out. */
export function NewTabPage({ onChoose, onChooseAgent, openKinds, openAgentIds, agents, agentsReady }: {
  onChoose: (kind: Exclude<TabKind, "new">) => void;
  onChooseAgent: (agent: { id: string; name: string }) => void;
  openKinds: TabKind[];
  openAgentIds: string[];
  agents: AgentOut[];
  agentsReady: boolean;
}) {
  const views = CHOICES.filter((choice) => !openKinds.includes(choice.kind));
  const people = agents.filter((agent) => !openAgentIds.includes(agent.id) && !agent.is_entry);
  return (
    <div className="conversation-new-tab">
      <h2 className="text-[13px] font-semibold">Open in this tab</h2>
      <div className="conversation-new-choices">
        {views.map((choice) => {
          const Icon = ICON[choice.kind];
          return (
            <button key={choice.kind} type="button" className="conversation-new-choice" onClick={() => onChoose(choice.kind)}>
              <span className="conversation-new-choice-name">
                <Icon aria-hidden="true" />
                {choice.title}
              </span>
              <span className="text-[11px] text-muted-foreground">{choice.detail}</span>
            </button>
          );
        })}
      </div>
      {views.length === 0 && <p className="mt-3 text-[12px] text-muted-foreground">Every view is already open.</p>}
      <h2 className="mt-5 text-[13px] font-semibold">Chat with an agent</h2>
      {!agentsReady && <p className="mt-2 text-[12px] text-muted-foreground">Send the team a request first. Then you can chat with each agent.</p>}
      <div className="conversation-new-choices">
        {people.map((agent) => (
          <button key={agent.id} type="button" className="conversation-new-choice" disabled={!agentsReady} onClick={() => onChooseAgent(agent)}>
            <span className="conversation-new-choice-name">
              <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} size={18} />
              {agent.name}
            </span>
            <span className="text-[11px] text-muted-foreground">{agent.role}</span>
          </button>
        ))}
      </div>
      {agents.length === 0 && <p className="mt-3 text-[12px] text-muted-foreground">This team has no agents yet.</p>}
    </div>
  );
}
