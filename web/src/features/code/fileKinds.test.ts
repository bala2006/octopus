import { describe, expect, it } from "vitest";
import { isImagePath } from "./fileKinds";

describe("isImagePath", () => {
  it("draws images and SVG files as pictures, in any letter case", () => {
    expect(isImagePath("favicon.svg")).toBe(true);
    expect(isImagePath("shots/morrow-desktop.PNG")).toBe(true);
    expect(isImagePath("assets/photo.jpeg")).toBe(true);
  });

  it("keeps code, markdown, and config files as text", () => {
    expect(isImagePath("app.js")).toBe(false);
    expect(isImagePath("README.md")).toBe(false);
    expect(isImagePath("index.html")).toBe(false);
    expect(isImagePath(".gitignore")).toBe(false);
  });

  it("looks only at the final extension", () => {
    expect(isImagePath("notes.png.txt")).toBe(false);
    expect(isImagePath("svg/readme")).toBe(false);
  });
});
