import { describe, expect, it } from "vitest";
import { changedLines } from "../src/lib/diff";

describe("changedLines", () => {
  it("shows only the lines between the first and last difference", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual({ text: "-b\n+B", lines: 2 });
  });

  it("counts a new file as all added and a deleted file as all removed", () => {
    expect(changedLines(null, "x\ny")).toEqual({ text: "+x\n+y", lines: 2 });
    expect(changedLines("x\ny", null)).toEqual({ text: "-x\n-y", lines: 2 });
  });

  it("finds no change in identical text", () => {
    expect(changedLines("same", "same")).toEqual({ text: "", lines: 0 });
  });
});