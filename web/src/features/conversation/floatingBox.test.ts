import { describe, expect, it } from "vitest";
import { FLOATING_GAP, FLOATING_MIN_HEIGHT, FLOATING_MIN_WIDTH, dockOf, fitPlacement, moveBox, resizeBox, snapPlacement, type FloatingBox } from "./floatingBox";

const start: FloatingBox = { top: 16, width: 400, height: 600 };
const bounds = { width: 1200, height: 800 };

describe("resizeBox", () => {
  it("widens a right-docked window when its inner edge moves left", () => {
    expect(resizeBox("inner", "right", start, -100, 0, bounds).width).toBe(500);
  });

  it("widens a left-docked window when its inner edge moves right", () => {
    expect(resizeBox("inner", "left", start, 100, 0, bounds).width).toBe(500);
  });

  it("keeps the width between the minimum and the canvas width", () => {
    expect(resizeBox("inner", "right", start, 1000, 0, bounds).width).toBe(FLOATING_MIN_WIDTH);
    expect(resizeBox("inner", "right", start, -5000, 0, bounds).width).toBe(bounds.width - 2 * FLOATING_GAP);
  });

  it("changes only the height when the bottom edge moves", () => {
    expect(resizeBox("bottom", "right", start, 50, 120, bounds)).toEqual({ top: 16, width: 400, height: 720 });
  });

  it("stops the bottom edge at the bottom of the canvas", () => {
    expect(resizeBox("bottom", "right", start, 0, 5000, bounds).height).toBe(bounds.height - 16 - FLOATING_GAP);
  });

  it("keeps the bottom edge fixed when the top edge moves", () => {
    const moved = resizeBox("top", "right", start, 0, 100, bounds);
    expect(moved.top + moved.height).toBe(start.top + start.height);
    expect(moved).toEqual({ top: 116, width: 400, height: 500 });
  });

  it("stops the top edge at the canvas top and at the minimum height", () => {
    expect(resizeBox("top", "right", start, 0, -500, bounds).top).toBe(FLOATING_GAP);
    const tall = resizeBox("top", "right", start, 0, 5000, bounds);
    expect(tall.height).toBe(FLOATING_MIN_HEIGHT);
    expect(tall.top + tall.height).toBe(start.top + start.height);
  });
});

describe("moveBox", () => {
  const size = { width: 400, height: 300 };
  const canvas = { width: 1200, height: 800 };
  const start = { right: 16, top: 16 };

  it("moves the window with the pointer: left for a negative dx, down for a positive dy", () => {
    expect(moveBox(start, -300, 120, size, canvas)).toEqual({ right: 316, top: 136 });
  });

  it("keeps the window inside the canvas on every side", () => {
    expect(moveBox(start, 5000, -5000, size, canvas)).toEqual({ right: FLOATING_GAP, top: FLOATING_GAP });
    expect(moveBox(start, -5000, 5000, size, canvas)).toEqual({
      right: canvas.width - size.width - FLOATING_GAP,
      top: canvas.height - size.height - FLOATING_GAP,
    });
  });

  it("keeps a window's full height inside the canvas by moving it up, before it would shrink", () => {
    expect(moveBox(start, 0, 400, size, canvas).top).toBe(416);
    expect(moveBox(start, 0, 5000, size, canvas).top).toBe(canvas.height - size.height - FLOATING_GAP);
  });

  it("lets a minimized window, shorter than the minimum height, reach the bottom edge", () => {
    const minimized = { width: 380, height: 34 };
    expect(moveBox(start, 0, 5000, minimized, canvas).top).toBe(canvas.height - minimized.height - FLOATING_GAP);
  });
});

describe("fitPlacement", () => {
  it("moves a window that would run off the bottom up, so its height stays", () => {
    expect(fitPlacement({ right: 16, top: 700 }, { width: 380, height: 600 }, { width: 1200, height: 800 })).toEqual({ right: 16, top: 184 });
  });

  it("puts a window taller than the canvas at the top, where the CSS trims it", () => {
    expect(fitPlacement({ right: 16, top: 300 }, { width: 380, height: 900 }, { width: 1200, height: 800 }).top).toBe(FLOATING_GAP);
  });
});

describe("snapPlacement", () => {
  const canvas = { width: 1200, height: 800 };
  const minimized = { width: 380, height: 89 };

  it("moves a minimized window to the nearer side and keeps its height on that side", () => {
    expect(snapPlacement({ right: 800, top: 300 }, minimized, canvas)).toEqual({ right: 1200 - 380 - FLOATING_GAP, top: 300 });
    expect(snapPlacement({ right: 300, top: 300 }, minimized, canvas)).toEqual({ right: FLOATING_GAP, top: 300 });
  });

  it("takes the bottom corner when the window is near the bottom edge", () => {
    expect(snapPlacement({ right: 30, top: 650 }, minimized, canvas)).toEqual({ right: FLOATING_GAP, top: canvas.height - minimized.height - FLOATING_GAP });
  });

  it("takes the top corner when the window is near the top edge, even past the left side", () => {
    expect(snapPlacement({ right: 900, top: 40 }, minimized, canvas)).toEqual({ right: 1200 - 380 - FLOATING_GAP, top: FLOATING_GAP });
  });
});

describe("dockOf", () => {
  it("docks by the side of the canvas that the window's centre is on", () => {
    expect(dockOf(16, 400, 1200)).toBe("right");
    expect(dockOf(784, 400, 1200)).toBe("left");
  });

  it("docks right until the canvas has a width", () => {
    expect(dockOf(784, 400, 0)).toBe("right");
  });
});