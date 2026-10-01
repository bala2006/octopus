/** A draggable divider that resizes the panel next to it. Width is remembered per panel; double-click resets it; arrow keys
 *  nudge it (it is a focusable "separator", so it works without a mouse too). */
import * as React from "react";
import { cn } from "@/lib/utils";

export const clampWidth = (px: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, px)));

/** Panel width in px, persisted in localStorage under `key`. `max` may depend on the window (call again on resize). */
export function usePanelWidth(key: string, initial: number, min: number, max: () => number) {
  const storageKey = `octopus-panel:${key}`;
  const [width, setWidth] = React.useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return clampWidth(Number.isFinite(saved) && saved > 0 ? saved : initial, min, max());
  });
  React.useEffect(() => { localStorage.setItem(storageKey, String(width)); }, [storageKey, width]);
  React.useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w, min, max()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [min, max]);
  const set = React.useCallback((px: number) => setWidth(clampWidth(px, min, max())), [min, max]);
  return { width, set, reset: () => set(initial), min, max };
}

export function ResizeHandle({ width, onResize, onReset, min, max, side, label, className }: {
  width: number; onResize: (px: number) => void; onReset: () => void; min: number; max: number;
  /** where the resized panel is: "left" = handle on its right edge (dragging right grows it), "right" = on its left edge */
  side: "left" | "right"; label: string; className?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  const start = React.useRef<{ x: number; w: number } | null>(null);
  const dir = side === "left" ? 1 : -1;
  React.useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => { if (start.current) onResize(start.current.w + dir * (e.clientX - start.current.x)); };
    const up = () => { setDragging(false); start.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, dir, onResize]);
  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={min} aria-valuemax={max}
      tabIndex={0} title="Drag to resize · double-click to reset" data-testid="resize-handle"
      onPointerDown={(e) => { e.preventDefault(); start.current = { x: e.clientX, w: width }; setDragging(true); }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === "ArrowLeft") { e.preventDefault(); onResize(width - dir * step); }
        if (e.key === "ArrowRight") { e.preventDefault(); onResize(width + dir * step); }
        if (e.key === "Home") { e.preventDefault(); onReset(); }
      }}
      className={cn("group relative z-10 w-1.5 shrink-0 cursor-col-resize select-none outline-none", className)}>
      <span className={cn("absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary/60 group-focus-visible:w-0.5 group-focus-visible:bg-primary",
        dragging && "w-0.5 bg-primary")} />
    </div>
  );
}
