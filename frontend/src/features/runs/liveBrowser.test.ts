import { describe, expect, it } from "vitest";
import { pagePoint } from "./useLiveBrowser";
import { firstLine, isDelegationMessage } from "./RunFeed";
import { attachmentPayload, nameFile } from "@/features/chat/attachments";

const img = (w: number, h: number, rect: { left: number; top: number; width: number; height: number }) =>
  ({ naturalWidth: w, naturalHeight: h, getBoundingClientRect: () => rect }) as unknown as HTMLImageElement;

describe("live browser click mapping", () => {
  it("maps a click on the letterboxed image to page CSS pixels", () => {
    // 1280x800 frame drawn into a 640x800 box: scale 0.5, 400px tall, top-aligned
    const el = img(1280, 800, { left: 100, top: 50, width: 640, height: 800 });
    expect(pagePoint({ clientX: 100 + 320, clientY: 50 + 200 }, el, { w: 1280, h: 800 })).toEqual({ x: 640, y: 400 });
    expect(pagePoint({ clientX: 100 + 10, clientY: 50 + 500 }, el, { w: 1280, h: 800 })).toBeNull(); // below the page
  });
  it("uses the page viewport when the frame is downscaled", () => {
    const el = img(800, 500, { left: 0, top: 0, width: 800, height: 500 });
    expect(pagePoint({ clientX: 400, clientY: 250 }, el, { w: 1600, h: 1000 })).toEqual({ x: 800, y: 500 });
  });
});

describe("pasted screenshots", () => {
  it("get unique readable names; real file names are kept", () => {
    const pasted = nameFile(new File(["x"], "image.png", { type: "image/png" }), 1);
    expect(pasted.name).toMatch(/^screenshot-\d{6}-2\.png$/);
    expect(nameFile(new File(["x"], "mockup.jpg", { type: "image/jpeg" }), 0).name).toBe("mockup.jpg");
  });
  it("images are sent as base64, text files as text", () => {
    expect(attachmentPayload([{ filename: "a.png", chars: 0, text: "", truncated: false, kind: "image", mime: "image/png", data: "QQ==" },
      { filename: "b.md", chars: 2, text: "hi", truncated: false }])).toEqual([
      { filename: "a.png", kind: "image", mime: "image/png", data: "QQ==" }, { filename: "b.md", text: "hi" }]);
  });
});

describe("delegation messages collapse", () => {
  it("are recognised by their meta and summarised by their first line", () => {
    expect(isDelegationMessage({ delegation: true })).toBe(true);
    expect(isDelegationMessage({ delegation_result: true })).toBe(true);
    expect(isDelegationMessage({ task_id: "T-1" })).toBe(false);
    expect(firstLine("\n## Objective: build the game\nmore")).toBe("Objective: build the game");
  });
});
