import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, GripVertical, Loader2, Minus } from "lucide-react";
import { useWorkspaceId } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { AgentPanel, type FloatingChatState } from "./AgentPanel";
import { usePanelSize } from "@/features/code/PanelResize";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { useChatFocus } from "./useOpenConversation";
import {
  FLOATING_GAP,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  resizeBox,
  type FloatingBox,
  type FloatingDock,
  type FloatingEdge,
} from "./floatingBox";

const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
type ConversationStyle = React.CSSProperties & {
  "--conversation-chat-width": string;
  "--conversation-chat-height": string;
  "--conversation-chat-top": string;
};

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

export default function AgentPage() {
  const w = useWorkspaceId();
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
  const box: FloatingBox = { top: top.size, width: width.size, height: height.size };
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
  const [dock, setDock] = React.useState<FloatingDock>("right");
  const changeWindowState = React.useCallback((state: FloatingChatState) => {
    setWindowState(state);
  }, []);
  const [canvasInsets, setCanvasInsets] = React.useState({ left: 0, right: 0 });
  const style: ConversationStyle = {
    "--conversation-chat-width": `${width.size}px`,
    "--conversation-chat-height": `${height.size}px`,
    "--conversation-chat-top": `${top.size}px`,
  };
  const windowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="floating-chat-window-control"
          aria-label="Chat window options"
          title="Chat window options"
        >
          <GripVertical />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" className="w-56">
        <DropdownMenuItem disabled={dock === "left"} onSelect={() => setDock("left")}>
          <ArrowLeft />
          Move to left pane
        </DropdownMenuItem>
        <DropdownMenuItem disabled={dock === "right"} onSelect={() => setDock("right")}>
          <ArrowRight />
          Move to right pane
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => changeWindowState("collapsed")}>
          <Minus />
          Minimize composer
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  React.useLayoutEffect(() => {
    const container = split.current;
    const panel = floatingChat.current;
    if (!container || !panel) return;
    const observer = new ResizeObserver(() => {
      const floating =
        getComputedStyle(panel).position === "absolute" &&
        panel.clientWidth > 0;
      const inset =
        floating && windowState === "expanded" ? panel.clientWidth + 16 : 0;
      setCanvasInsets({
        left: dock === "left" ? inset : 0,
        right: dock === "right" ? inset : 0,
      });
    });
    observer.observe(container);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [dock, windowState]);
  return (
    <div className="conversation-studio" style={style}>
      <div className="conversation-split" ref={split}>
        <section
          id="conversation-canvas"
          className="conversation-canvas-panel"
          aria-label="Team canvas"
        >
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
              leftInset={canvasInsets.left}
            />
          </React.Suspense>
        </section>
        <div
          className="conversation-floating-chat"
          data-window-state={windowState}
          data-dock={dock}
          ref={floatingChat}
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
                floatingWindow={{
                  state: windowState,
                  onStateChange: changeWindowState,
                  menu: windowMenu,
                }}
                onOpen={(path) =>
                  navigate(`/w/${w}/workspace?file=${encodeURIComponent(path)}`)
                }
                onClose={() => navigate(`/w/${w}/workspace`)}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
