import { describe, expect, it } from "vitest";
import { dataUrlBytes, fitWithin, isImage } from "@/lib/images";
import { clampWidth } from "./ResizeHandle";
import { wireFiles, wireImages } from "./Composer";
import { initialRun, reduceRun } from "@/features/runs/runState";

describe("images", () => {
  it("scales the longer side down to the limit and never enlarges", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1000, 6000)).toEqual({ width: 341, height: 2048 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("knows image types and a data URL's size", () => {
    expect(isImage(new File([], "a.png", { type: "image/png" }))).toBe(true);
    expect(isImage(new File([], "a.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(dataUrlBytes("data:image/png;base64,AAAA")).toBe(3);
  });

  it("sends images and files in the shape the backend expects", () => {
    expect(wireImages([{ id: "1", name: "s.png", dataUrl: "data:image/png;base64,AAAA", width: 1, height: 1, bytes: 3 }]))
      .toEqual([{ name: "s.png", data_url: "data:image/png;base64,AAAA" }]);
    expect(wireFiles([{ filename: "a.md", text: "hi", chars: 2, truncated: false }])).toEqual([{ filename: "a.md", text: "hi" }]);
  });
});

describe("resizable panels", () => {
  it("keep their width between the limits", () => {
    expect(clampWidth(100, 320, 900)).toBe(320);
    expect(clampWidth(1200, 320, 900)).toBe(900);
    expect(clampWidth(512.4, 320, 900)).toBe(512);
  });
});

describe("team ledger", () => {
  it("shows each item once, updated in place", () => {
    let s = reduceRun(initialRun(), { type: "ledger_updated", seq: 1, data: { agent_id: "a", items: [
      { id: "L1", kind: "decision", text: "Use SQLite", status: "active" }, { id: "L2", kind: "question", text: "Auth?", status: "open" }] } }, { a: "Ann" });
    s = reduceRun(s, { type: "ledger_updated", seq: 2, data: { agent_id: "b", items: [
      { id: "L1", kind: "decision", text: "Use PostgreSQL", status: "active", note: "concurrent writes", revisions: 1 }] } }, { b: "Ben" });
    expect(Object.values(s.ledger).map((i) => [i.id, i.text])).toEqual([["L1", "Use PostgreSQL"], ["L2", "Auth?"]]);
    expect(s.timeline.at(-1)?.label).toBe("Ben updated the ledger: L1");
  });
});
