/**
 * The geometry of the floating chat window. The window sits on one side of the team canvas (its dock). Its inner edge
 * sets the width, its top edge moves the top, and its bottom edge sets the height. The outer edge is the screen side
 * the window is docked to, so it stays put.
 */
export type FloatingEdge = "inner" | "top" | "bottom";
export type FloatingDock = "left" | "right";
export type FloatingBox = { top: number; width: number; height: number };
export type FloatingBounds = { width: number; height: number };

export const FLOATING_GAP = 16;
export const FLOATING_MIN_WIDTH = 300;
export const FLOATING_MIN_HEIGHT = 240;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** The box after dragging `edge` by (dx, dy) pixels from `start`, kept inside the canvas bounds and the minimum size. */
export function resizeBox(
  edge: FloatingEdge,
  dock: FloatingDock,
  start: FloatingBox,
  dx: number,
  dy: number,
  bounds: FloatingBounds,
): FloatingBox {
  if (edge === "inner") {
    const width = clamp(
      start.width + (dock === "right" ? -dx : dx),
      FLOATING_MIN_WIDTH,
      bounds.width - 2 * FLOATING_GAP,
    );
    return { ...start, width };
  }
  if (edge === "bottom") {
    const height = clamp(
      start.height + dy,
      FLOATING_MIN_HEIGHT,
      bounds.height - start.top - FLOATING_GAP,
    );
    return { ...start, height };
  }
  const bottom = start.top + start.height;
  const top = clamp(start.top + dy, FLOATING_GAP, bottom - FLOATING_MIN_HEIGHT);
  return { ...start, top, height: bottom - top };
}
