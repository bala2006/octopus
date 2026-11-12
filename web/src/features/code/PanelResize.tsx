import * as React from "react";
import { cn } from "@/lib/utils";

export function usePanelSize(
  name: string,
  initial: number,
  min: number,
  max: number,
) {
  const clamp = React.useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [min, max],
  );
  const [size, update] = React.useState(() => {
    try {
      const stored = Number(localStorage.getItem(`octopus-panel-${name}`));
      return stored ? clamp(stored) : initial;
    } catch {
      return initial;
    }
  });
  const setSize = React.useCallback(
    (value: number) => update(clamp(value)),
    [clamp],
  );
  React.useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(`octopus-panel-${name}`, String(size));
      } catch {
        /* Resizing works without preference storage. */
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [size, name]);
  return { size, setSize, min, max };
}

export function PanelResize({
  label,
  orientation,
  panel,
  pixelsToUnits = (value) => value,
  unit = "pixels",
}: {
  label: string;
  orientation: "vertical" | "horizontal";
  panel: ReturnType<typeof usePanelSize>;
  pixelsToUnits?: (delta: number) => number;
  unit?: string;
}) {
  const dragging = React.useRef<{ position: number; size: number }>();
  const [active, setActive] = React.useState(false);
  const coordinate = (event: React.PointerEvent) =>
    orientation === "vertical" ? event.clientX : event.clientY;
  const finish = () => {
    dragging.current = undefined;
    setActive(false);
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={panel.min}
      aria-valuemax={panel.max}
      aria-valuenow={Math.round(panel.size)}
      aria-valuetext={`${Math.round(panel.size)} ${unit}`}
      tabIndex={0}
      className={cn(
        "relative z-10 shrink-0 touch-none select-none bg-border transition-colors hover:bg-primary/60 focus-visible:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        orientation === "vertical"
          ? "hidden w-1 cursor-col-resize md:block"
          : "h-1 cursor-row-resize",
        active && "bg-primary",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = { position: coordinate(event), size: panel.size };
        setActive(true);
      }}
      onPointerMove={(event) => {
        if (dragging.current)
          panel.setSize(
            dragging.current.size +
              pixelsToUnits(coordinate(event) - dragging.current.position),
          );
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const increase =
          orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        if (event.key === decrease || event.key === increase) {
          event.preventDefault();
          panel.setSize(
            panel.size +
              (event.key === increase ? 1 : -1) * (unit === "percent" ? 2 : 16),
          );
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          panel.setSize(event.key === "Home" ? panel.min : panel.max);
        }
      }}
    >
      <span
        className={cn(
          "absolute",
          orientation === "vertical"
            ? "-left-1 h-full w-3"
            : "-top-1 h-3 w-full",
        )}
      />
    </div>
  );
}
