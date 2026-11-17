import * as React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GripVertical, ListTodo, Loader2 } from "lucide-react";
import { useCanvas as useCanvasQuery, useCompanyId, useWorkspaceId } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { AgentPanel, type FloatingChatState } from "./AgentPanel";
import { ConversationTabs, NewTabPage, type ConversationTab, type TabKind } from "./ConversationTabs";
import { BrowserTab, ChangesTab, DetailsPanel, ReviewTab, UsageTab } from "./RunViews";
import { useRunView } from "./runView";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { TeamPulse } from "@/components/layout/DesktopLayout";
import { ProcessIndicator } from "@/components/layout/ProcessIndicator";
import { ModelStatus, TeamSwitcher } from "@/components/layout/AppShell";
import type { FileTotal } from "@/features/runs/steps";
import { usePanelSize } from "@/features/code/PanelResize";
import { GitTab } from "@/features/code/GitTab";
import { useChatFocus } from "./useOpenConversation";
import {
  dockOf,
  FLOATING_GAP,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  moveBox,
  resizeBox,
  type FloatingBox,
  type FloatingDock,
  type FloatingEdge,
  type FloatingPlacement,
} from "./floatingBox";

const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
const WorkspacePage = React.lazy(() => import("@/features/code/WorkspacePage"));
type ConversationStyle = React.CSSProperties & {
  "--conversation-chat-width": string;
  "--conversation-chat-height": string;
  "--conversation-chat-top": string;
  "--conversation-chat-right": string;
};

/** The conversation page's tabs and which one is showing. Chat is always among them. */
type TabLayout = { tabs: ConversationTab[]; activeId: string };
const TABS_KEY = "octopus-conversation-tabs";
const DEFAULT_LAYOUT: TabLayout = { tabs: [{ id: "chat", kind: "chat" }, { id: "canvas", kind: "canvas" }], activeId: "canvas" };

const DETAILS_KEY = "octopus-conversation-details";


/** Whether the details panel is open. It starts open. */
function readDetailsOpen(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** The saved tabs, or the default layout when none are saved or the saved ones are not usable. */
function readLayout(): TabLayout {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "null") as TabLayout | null;
    if (saved && Array.isArray(saved.tabs) && saved.tabs.some((t) => t.kind === "chat") && saved.tabs.some((t) => t.id === saved.activeId)) return saved;
  } catch {
    /* Fall back to the default layout. */
  }
  return DEFAULT_LAYOUT;
}

/** The last "open this conversation" request the chat window has shown. */
let consumedFocus = 0;

const KEY_STEP = 16;
const ARROW_MOVES: Record<string, [dx: number, dy: number]> = {
  ArrowLeft: [-KEY_STEP, 0],
  ArrowRight: [KEY_STEP, 0],
  ArrowUp: [0, -KEY_STEP],
  ArrowDown: [0, KEY_STEP],
};

/** One resize edge of the floating chat. Dragging or arrow keys resize the window from that edge. */
function EdgeHandle({
  edge,
  label,
  box,
  dock,
  container,
  onResize,
}: {
  edge: FloatingEdge;
  label: string;
  box: FloatingBox;
  dock: FloatingDock;
  container: React.RefObject<HTMLDivElement>;
  onResize: (next: FloatingBox) => void;
}) {
  const drag = React.useRef<{ x: number; y: number; start: FloatingBox } | null>(null);
  const bounds = () => ({
    width: container.current?.clientWidth ?? 0,
    height: container.current?.clientHeight ?? 0,
  });
  const end = () => {
    drag.current = null;
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={edge === "inner" ? "vertical" : "horizontal"}
      tabIndex={0}
      className="floating-chat-edge"
      data-edge={edge}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, start: box };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        onResize(
          resizeBox(edge, dock, d.start, event.clientX - d.x, event.clientY - d.y, bounds()),
        );
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        const move = ARROW_MOVES[event.key];
        if (!move) return;
        event.preventDefault();
        onResize(resizeBox(edge, dock, box, move[0], move[1], bounds()));
      }}
    />
  );
}

/** The grip on the chat's title bar. Press and drag it to move the window anywhere on the canvas. Arrow keys move it too. */
function WindowGrip({
  target,
  container,
  placement,
  onMove,
}: {
  target: React.RefObject<HTMLDivElement>;
  container: React.RefObject<HTMLDivElement>;
  placement: FloatingPlacement;
  onMove: (next: FloatingPlacement) => void;
}) {
  const drag = React.useRef<{ x: number; y: number; start: FloatingPlacement } | null>(null);
  const size = () => ({
    width: target.current?.offsetWidth ?? 0,
    height: target.current?.offsetHeight ?? 0,
  });
  const bounds = () => ({
    width: container.current?.clientWidth ?? 0,
    height: container.current?.clientHeight ?? 0,
  });
  const end = () => {
    drag.current = null;
  };
  return (
    <button
      type="button"
      className="floating-chat-window-control floating-chat-grip"
      aria-label="Move chat window"
      title="Press and drag to move the chat anywhere on the canvas"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, start: placement };
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        onMove(moveBox(d.start, event.clientX - d.x, event.clientY - d.y, size(), bounds()));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(event) => {
        const move = ARROW_MOVES[event.key];
        if (!move) return;
        event.preventDefault();
        onMove(moveBox(placement, move[0], move[1], size(), bounds()));
      }}
    >
      <GripVertical />
    </button>
  );
}

export default function AgentPage() {
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const teamAgents = useCanvasQuery(w, companyId).data?.agents ?? [];
  const runId = useRunView((v) => v.runId);
  const tree = useQuery({
    queryKey: ["editor-tree", w],
    enabled: !!w,
    refetchInterval: 4000,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/tree", {
          params: { path: { workspace_id: w } },
        }),
      ),
  });
  const navigate = useNavigate();
  const split = React.useRef<HTMLDivElement>(null);
  const floatingChat = React.useRef<HTMLDivElement>(null);
  const width = usePanelSize("floating-conversation-chat", 380, FLOATING_MIN_WIDTH, 4000);
  const height = usePanelSize("floating-conversation-height", 620, FLOATING_MIN_HEIGHT, 4000);
  const top = usePanelSize("floating-conversation-top", FLOATING_GAP, FLOATING_GAP, 4000);
  const right = usePanelSize("floating-conversation-right", FLOATING_GAP, FLOATING_GAP, 10000);
  const box: FloatingBox = { top: top.size, width: width.size, height: height.size };
  const [frame, setFrame] = React.useState({ canvas: { width: 0, height: 0 }, window: { width: 0, height: 0 } });
  const [details, setDetails] = React.useState(readDetailsOpen);
  React.useEffect(() => {
    try {
      localStorage.setItem(DETAILS_KEY, details ? "open" : "closed");
    } catch {
      /* The panel still works without remembering it. */
    }
  }, [details]);
  // The stored place is kept as the user left it. What shows is clamped to the canvas as it is now, so a browser that shrinks
  // never leaves the window below the screen, and the window returns to its place when the browser grows again.
  const stored: FloatingPlacement = { right: right.size, top: top.size };
  const placement = frame.canvas.width ? moveBox(stored, 0, 0, frame.window, frame.canvas) : stored;
  const dock = dockOf(placement.right, width.size, frame.canvas.width);  const move = (next: FloatingPlacement) => {
    right.setSize(next.right);
    top.setSize(next.top);
  };
  const resize = (next: FloatingBox) => {
    width.setSize(next.width);
    height.setSize(next.height);
    top.setSize(next.top);
  };
  const focus = useChatFocus((s) => s.token);
  const [windowState, setWindowState] =
    React.useState<FloatingChatState>(() => (focus > consumedFocus ? "expanded" : "minimized"));
  React.useEffect(() => {
    if (focus <= consumedFocus) return;
    consumedFocus = focus;
    setWindowState("expanded");
  }, [focus]);
  const changeWindowState = React.useCallback((state: FloatingChatState) => {
    setWindowState(state);
  }, []);
  const [canvasInsets, setCanvasInsets] = React.useState({ left: 0, right: 0 });
  // The room the toolbar keeps clear on the right: the chat window in any visible state, when it is docked right.
  const [chatReserve, setChatReserve] = React.useState(0);
  const [layout, setLayout] = React.useState<TabLayout>(readLayout);
  React.useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(layout));
    } catch {
      /* The tabs still work without remembering them. */
    }
  }, [layout]);
  const active = layout.tabs.find((t) => t.id === layout.activeId) ?? layout.tabs[0]!;
  const activeKind: TabKind = active.kind;
  const [changes, setChanges] = React.useState<FileTotal[]>([]);
  const selectTab = (id: string) => setLayout((l) => ({ ...l, activeId: id }));
  const moveTab = (id: string, index: number) =>
    setLayout((l) => {
      const moving = l.tabs.find((t) => t.id === id);
      if (!moving || moving.kind === "chat") return l;
      const rest = l.tabs.filter((t) => t.id !== id);
      const at = Math.max(1, Math.min(index, rest.length));
      return { ...l, tabs: [...rest.slice(0, at), moving, ...rest.slice(at)] };
    });
  const newTab = () => {
    const id = `tab-${Date.now().toString(36)}`;
    setLayout((l) => ({ tabs: [...l.tabs, { id, kind: "new" }], activeId: id }));
  };
  // A link opens a tab with ?tab=canvas or ?tab=code. The tab opens once, and the parameter is then dropped.
  const { key: locationKey } = useLocation();
  const [params, setParams] = useSearchParams();
  React.useEffect(() => {
    const wanted = params.get("tab");
    if (wanted !== "canvas" && wanted !== "code") return;
    setLayout((l) => {
      const existing = l.tabs.find((t) => t.kind === wanted);
      if (existing) return { ...l, activeId: existing.id };
      const id = `tab-${Date.now().toString(36)}`;
      return { tabs: [...l.tabs, { id, kind: wanted }], activeId: id };
    });
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("tab");
      return next;
    }, { replace: true });
  }, [locationKey, params, setParams]);
  const openFile = (path: string) => {
    setLayout((l) => {
      const existing = l.tabs.find((t) => t.kind === "code");
      if (existing) return { ...l, activeId: existing.id };
      const id = `tab-${Date.now().toString(36)}`;
      return { tabs: [...l.tabs, { id, kind: "code" as const }], activeId: id };
    });
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("file", path);
        return next;
      },
      { replace: true },
    );
  };
  const openAgentTab = (agent: { id: string; name: string }) =>
    setLayout((l) => ({ ...l, tabs: l.tabs.map((t) => (t.id === l.activeId ? { id: t.id, kind: "agent" as const, agentId: agent.id, title: agent.name } : t)) }));
  const chooseKind = (kind: TabKind) => setLayout((l) => ({ ...l, tabs: l.tabs.map((t) => (t.id === l.activeId ? { ...t, kind } : t)) }));
  const closeTab = (id: string) =>
    setLayout((l) => {
      const tabs = l.tabs.filter((t) => t.id !== id);
      return { tabs, activeId: l.activeId === id ? (tabs[tabs.length - 1]?.id ?? "chat") : l.activeId };
    });
  const style: ConversationStyle = {
    "--conversation-chat-width": `${width.size}px`,
    "--conversation-chat-height": `${height.size}px`,
    "--conversation-chat-top": `${placement.top}px`,
    "--conversation-chat-right": `${placement.right}px`,
  };
  /**
   * The collapsed chat is an orb: press and drag it anywhere on the canvas. The drag follows the pointer on the window, so
   * it keeps going when the pointer moves off the orb. A press without a move still restores the chat (see orbClick).
   */
  const orbSuppressClick = React.useRef(false);
  const orbSize = () => ({ width: floatingChat.current?.offsetWidth ?? 0, height: floatingChat.current?.offsetHeight ?? 0 });
  const canvasBounds = () => ({ width: split.current?.clientWidth ?? 0, height: split.current?.clientHeight ?? 0 });
  const orbDown = (event: React.PointerEvent) => {
    if (windowState !== "collapsed" || event.button !== 0) return;
    orbSuppressClick.current = false;
    const press = { x: event.clientX, y: event.clientY, start: placement, moved: false };
    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < 4) return;
      press.moved = true;
      move(moveBox(press.start, dx, dy, orbSize(), canvasBounds()));
    };
    const onUp = () => {
      if (press.moved) orbSuppressClick.current = true;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };
  const orbClick = (event: React.MouseEvent) => {
    if (!orbSuppressClick.current) return;
    orbSuppressClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  };  React.useLayoutEffect(() => {
    const container = split.current;
    const panel = floatingChat.current;
    if (!container || !panel) return;
    const observer = new ResizeObserver(() => {
      setFrame({ canvas: { width: container.clientWidth, height: container.clientHeight }, window: { width: panel.offsetWidth, height: panel.offsetHeight } });
      const floating =
        getComputedStyle(panel).position === "absolute" &&
        panel.clientWidth > 0;
      const inset =
        floating && windowState === "expanded" ? panel.clientWidth + 16 : 0;
      setCanvasInsets({
        left: dock === "left" ? inset : 0,
        right: dock === "right" ? inset : 0,
      });
      setChatReserve(floating && dock === "right" ? panel.clientWidth + 16 : 0);
    });
    observer.observe(container);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [dock, windowState, activeKind]);
  return (
    <div className="conversation-studio" style={style} data-details={details ? "open" : "closed"}>
      <ConversationTabs
        tabs={layout.tabs}
        activeId={layout.activeId}
        changes={changes}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onMove={moveTab}
        actions={
          <>
            {active.kind === "chat" && (
              <button
                type="button"
                className="conversation-tabs-toggle"
                aria-pressed={details}
                aria-label={details ? "Hide details" : "Show details"}
                title={details ? "Hide details" : "Show details"}
                onClick={() => setDetails((open) => !open)}
              >
                <ListTodo aria-hidden="true" />
              </button>
            )}
            <div className="hidden sm:block">
              <TeamSwitcher />
            </div>
            <ProcessIndicator />
            <ModelStatus />
            <TeamPulse />
            <CommandPalette />
          </>
        }
      />
      {active.kind === "chat" || active.kind === "agent" ? (
        <div className="conversation-chat-view">
          <AgentPanel
            key={active.id}
            initialAgent={active.kind === "agent" ? active.agentId : undefined}
            workspace={w}
            files={tree.data?.files ?? []}
            presentation="conversation"
            onChanges={setChanges}
            onOpen={(path) => navigate(`/w/${w}/agent?tab=code&file=${encodeURIComponent(path)}`)}
            onClose={() => navigate(`/w/${w}/agent?tab=code`)}
          />
        </div>
      ) : (
      <div className="conversation-split" ref={split}>
        <section
          id="conversation-canvas"
          className="conversation-canvas-panel"
          aria-label="Team canvas"
        >
          {activeKind === "changes" ? (
            <ChangesTab />
          ) : activeKind === "browser" ? (
            <BrowserTab />
          ) : activeKind === "review" ? (
            <ReviewTab />
          ) : activeKind === "code" ? (
            <div className="conversation-page-tab" style={{ paddingRight: chatReserve }}>
              <React.Suspense fallback={<p className="conversation-detail-empty">Loading code.</p>}>
                <WorkspacePage embedded />
              </React.Suspense>
            </div>
          ) : activeKind === "git" ? (
            <GitTab onOpen={openFile} reserveRight={chatReserve} />
          ) : activeKind === "usage" ? (
            <UsageTab />
          ) : activeKind === "new" ? (
            <NewTabPage onChoose={chooseKind} onChooseAgent={openAgentTab} agents={teamAgents} agentsReady={!!runId} openKinds={layout.tabs.filter((t) => t.id !== layout.activeId).map((t) => t.kind)} openAgentIds={layout.tabs.flatMap((t) => (t.agentId ? [t.agentId] : []))} />
          ) : (
          <React.Suspense
            fallback={
              <div
                className="flex h-full items-center justify-center"
                role="status"
              >
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="sr-only">Loading canvas</span>
              </div>
            }
          >
            <CanvasPage
              embedded
              rightInset={canvasInsets.right}
              toolbarInset={chatReserve}
              leftInset={canvasInsets.left}
            />
          </React.Suspense>
          )}
        </section>
        <div
          className="conversation-floating-chat"
          data-window-state={windowState}
          data-dock={dock}
          ref={floatingChat}
          onPointerDown={orbDown}
          onClickCapture={orbClick}
        >
          <EdgeHandle edge="inner" label="Resize chat width" box={box} dock={dock} container={split} onResize={resize} />
          <EdgeHandle edge="top" label="Resize chat from the top" box={box} dock={dock} container={split} onResize={resize} />
          <EdgeHandle edge="bottom" label="Resize chat height" box={box} dock={dock} container={split} onResize={resize} />
          <section
            id="conversation-chat"
            className="conversation-chat-panel"
            aria-label="Conversation"
          >
            <div className="conversation-chat-content">
              <AgentPanel
                workspace={w}
                files={tree.data?.files ?? []}
                presentation="conversation"
                onChanges={setChanges}
                floatingWindow={{
                  state: windowState,
                  onStateChange: changeWindowState,
                  grip: (
                    <WindowGrip
                      target={floatingChat}
                      container={split}
                      placement={placement}
                      onMove={move}
                    />
                  ),
                }}
                onOpen={(path) =>
                  navigate(`/w/${w}/agent?tab=code&file=${encodeURIComponent(path)}`)
                }
                onClose={() => navigate(`/w/${w}/agent?tab=code`)}
              />
            </div>
          </section>
        </div>
      </div>
      )}
      {details && active.kind === "chat" && <DetailsPanel />}
    </div>
  );
}
