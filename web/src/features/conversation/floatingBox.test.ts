import { describe, expect, it } from "vitest";
import { FLOATING_GAP, FLOATING_MIN_HEIGHT, FLOATING_MIN_WIDTH, resizeBox, type FloatingBox } from "./floatingBox";

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
