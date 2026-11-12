/** Live view of one agent's real browser tab: CDP screencast frames over /ws/w/{w}/runs/{run}/browser/{agent}. */
import * as React from "react";
import { wsUrl } from "@/lib/api";
import { ResilientSocket } from "@/lib/socket";

type LiveMsg =
  | { type: "status"; live: boolean; reason?: string; url?: string; title?: string }
  | { type: "frame"; data: string; w?: number; h?: number }
  | { type: "url"; url: string };

export interface LiveBrowser {
  /** a frame has arrived since the stream (re)started */
  live: boolean;
  url: string;
  reason: string;
  /** the page's CSS viewport, to map clicks on the image to page coordinates */
  size: React.MutableRefObject<{ w: number; h: number }>;
  send: (m: Record<string, unknown>) => void;
}

/**
 * Frames are written straight into `img` (no React render per frame). `enabled` = the run is live and the user follows
 * the latest step; otherwise the socket stays closed and the Browser tab shows the recorded screenshots.
 */
export function useLiveBrowser(w: string, runId: string, agentId: string | undefined, enabled: boolean,
  img: React.RefObject<HTMLImageElement>): LiveBrowser {
  const [live, setLive] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [reason, setReason] = React.useState("");
  const size = React.useRef({ w: 0, h: 0 });
  const sock = React.useRef<ResilientSocket<LiveMsg> | null>(null);
  React.useEffect(() => {
    setLive(false); setUrl(""); setReason("");
    if (!enabled || !agentId || !w || !runId) return;
    let gotFrame = false;
    const s = new ResilientSocket<LiveMsg>({
      url: () => wsUrl(`/ws/w/${w}/runs/${runId}/browser/${encodeURIComponent(agentId)}`),
      onEvent: (m) => {
        if (m.type === "frame") {
          if (m.w && m.h) size.current = { w: m.w, h: m.h };
          if (img.current) img.current.src = `data:image/jpeg;base64,${m.data}`;
          if (!gotFrame) { gotFrame = true; setLive(true); }
        } else if (m.type === "url") {
          setUrl(m.url);
        } else if (m.type === "status") {
          if (m.url) setUrl(m.url);
          if (!m.live) { gotFrame = false; setLive(false); setReason(m.reason ?? ""); }
        }
      },
    });
    sock.current = s;
    return () => { s.close(); sock.current = null; };
  }, [w, runId, agentId, enabled, img]);
  const send = React.useCallback((m: Record<string, unknown>) => sock.current?.send(m), []);
  return { live, url, reason, size, send };
}

const MODS = (e: React.MouseEvent | React.KeyboardEvent | React.WheelEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTON = ["left", "middle", "right"] as const;

/** Page coordinates (CSS px) of a pointer event on the `object-contain object-top` image, or null outside the page. */
export function pagePoint(e: { clientX: number; clientY: number }, el: HTMLImageElement, page: { w: number; h: number }): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  const nw = el.naturalWidth || page.w, nh = el.naturalHeight || page.h;
  if (!nw || !nh || !page.w || !page.h) return null;
  const scale = Math.min(r.width / nw, r.height / nh);
  const dw = nw * scale, dh = nh * scale;
  const ox = (r.width - dw) / 2;
  const x = (e.clientX - r.left - ox) / dw, y = (e.clientY - r.top) / dh;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: Math.round(x * page.w * 10) / 10, y: Math.round(y * page.h * 10) / 10 };
}

/** Event handlers that forward the user's mouse, wheel and keys to the agent's tab (when they take control). */
export function controlHandlers(lb: LiveBrowser, img: React.RefObject<HTMLImageElement>) {
  let lastMove = 0;
  const point = (e: React.MouseEvent) => (img.current ? pagePoint(e, img.current, lb.size.current) : null);
  const mouse = (event: string) => (e: React.MouseEvent) => {
    const p = point(e);
    if (!p) return;
    if (event === "mouseMoved") {
      const now = performance.now();
      if (now - lastMove < 40) return; // ~25 moves per second is plenty
      lastMove = now;
    } else e.preventDefault();
    lb.send({ type: "mouse", event, ...p, button: event === "mouseMoved" ? "none" : BUTTON[e.button] ?? "left", clicks: event === "mouseMoved" ? 0 : e.detail || 1, modifiers: MODS(e) });
  };
  const key = (event: "keyDown" | "keyUp") => (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && event === "keyDown" && e.shiftKey) return; // Shift+Esc leaves control (handled by the view)
    e.preventDefault();
    lb.send({ type: "key", event, key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : e.key === "Enter" ? "\r" : "", modifiers: MODS(e) });
  };
  return {
    onMouseDown: mouse("mousePressed"), onMouseUp: mouse("mouseReleased"), onMouseMove: mouse("mouseMoved"),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onWheel: (e: React.WheelEvent) => { const p = point(e); if (p) lb.send({ type: "wheel", ...p, dx: e.deltaX, dy: e.deltaY, modifiers: MODS(e) }); },
    onKeyDown: key("keyDown"), onKeyUp: key("keyUp"),
  };
}
