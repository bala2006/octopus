import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  GripVertical,
  Loader2,
  Maximize2,
  Minus,
} from "lucide-react";
import { useWorkspaceId } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { AgentPanel, type FloatingChatState } from "./AgentPanel";
import { PanelResize, usePanelSize } from "@/features/code/PanelResize";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { useChatFocus } from "./useOpenConversation";
import "./conversation-layout.css";

const CanvasPage = React.lazy(() => import("@/features/canvas/CanvasPage"));
type ConversationStyle = React.CSSProperties & {
  "--conversation-chat-width": string;
};

/** The last "open this conversation" request the chat window has shown. */
let consumedFocus = 0;

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
  const chat = usePanelSize("floating-conversation-chat", 380, 340, 520);
  const focus = useChatFocus((s) => s.token);
  const [windowState, setWindowState] =
    React.useState<FloatingChatState>(() => (focus > consumedFocus ? "expanded" : "minimized"));
  React.useEffect(() => {
    if (focus <= consumedFocus) return;
    consumedFocus = focus;
    setWindowState((v) => (v === "full" ? v : "expanded"));
  }, [focus]);
  const [dock, setDock] = React.useState<"left" | "right">("right");
  const changeWindowState = React.useCallback((state: FloatingChatState) => {
    setWindowState(state);
  }, []);
  const [canvasInsets, setCanvasInsets] = React.useState({ left: 0, right: 0 });
  const style: ConversationStyle = {
    "--conversation-chat-width": `${chat.size}px`,
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
        <DropdownMenuItem
          onSelect={() =>
            changeWindowState(windowState === "full" ? "expanded" : "full")
          }
        >
          <Maximize2 />
          {windowState === "full"
            ? "Return to floating view"
            : "Open in full view"}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={dock === "left" && windowState !== "full"}
          onSelect={() => {
            setDock("left");
            if (windowState === "full") changeWindowState("expanded");
          }}
        >
          <ArrowLeft />
          Move to left pane
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={dock === "right" && windowState !== "full"}
          onSelect={() => {
            setDock("right");
            if (windowState === "full") changeWindowState("expanded");
          }}
        >
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
          onPointerDownCapture={() => changeWindowState("collapsed")}
          onFocusCapture={() => changeWindowState("collapsed")}
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
          <PanelResize
            label="Resize floating chat"
            orientation="vertical"
            panel={chat}
            pixelsToUnits={(delta) => (dock === "right" ? -delta : delta)}
          />
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
