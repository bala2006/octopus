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

/**
 * Where the window sits. `right` is the gap between the window's right edge and the canvas's right edge, so a window
 * docked to the right keeps its gap when the canvas resizes. `top` is the gap from the canvas's top edge.
 */
export type FloatingPlacement = { right: number; top: number };

/**
 * The placement with a window of `size` fully inside the canvas. A window low on the canvas moves up to fit, so its height
 * survives its position. Only a canvas shorter than the window shrinks it (the CSS does that).
 */
export function fitPlacement(place: FloatingPlacement, size: FloatingBounds, canvas: FloatingBounds): FloatingPlacement {
  return {
    right: clamp(place.right, FLOATING_GAP, canvas.width - size.width - FLOATING_GAP),
    top: clamp(place.top, FLOATING_GAP, canvas.height - size.height - FLOATING_GAP),
  };
}

/** The placement after dragging the window by (dx, dy) pixels, kept fully inside the canvas. Positive dx moves it right. */
export function moveBox(start: FloatingPlacement, dx: number, dy: number, size: FloatingBounds, canvas: FloatingBounds): FloatingPlacement {
  return fitPlacement({ right: start.right - dx, top: start.top + dy }, size, canvas);
}

/** How close, as a share of the canvas height, a window must be to the top or bottom edge to take that corner. */
const CORNER_REACH = 0.25;

/**
 * Where a minimized window rests: against the nearer side of the canvas, and in that side's corner when it is close to the
 * top or the bottom edge. Otherwise it keeps its height on the side.
 */
export function snapPlacement(place: FloatingPlacement, size: FloatingBounds, canvas: FloatingBounds): FloatingPlacement {
  const left = canvas.width - place.right - size.width;
  const nextRight = left + size.width / 2 < canvas.width / 2 ? canvas.width - size.width - FLOATING_GAP : FLOATING_GAP;
  const reach = CORNER_REACH * canvas.height;
  let top = place.top;
  if (top - FLOATING_GAP <= reach) top = FLOATING_GAP;
  else if (canvas.height - (top + size.height) - FLOATING_GAP <= reach) top = canvas.height - size.height - FLOATING_GAP;
  return fitPlacement({ right: nextRight, top }, size, canvas);
}

/** The side of the canvas the window's centre is on. That side decides where the resize handle and the canvas inset go. */
export function dockOf(right: number, width: number, canvasWidth: number): FloatingDock {
  if (canvasWidth <= 0) return "right";
  const centre = canvasWidth - right - width / 2;
  return centre < canvasWidth / 2 ? "left" : "right";
}
