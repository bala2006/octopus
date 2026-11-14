import { describe, expect, it } from "vitest";
import { pickedFolder } from "../src/services/dialog";

describe("pickedFolder", () => {
  it("returns the folder the Windows dialog marked, even after other output", () => {
    expect(pickedFolder("powershell", 0, "a helper line\nOCTOPUS_PICK:C:\\Projects\\app\n")).toBe("C:\\Projects\\app");
  });

  it("returns null when the Windows dialog is cancelled", () => {
    expect(pickedFolder("powershell", 0, "")).toBeNull();
  });

  it("throws with the exit code when the Windows dialog fails", () => {
    expect(() => pickedFolder("powershell", 1, "boom")).toThrow(/exit 1\): boom/);
  });

  it("returns the path that zenity, kdialog or yad prints", () => {
    expect(pickedFolder("zenity", 0, "/home/me/app/\n")).toBe("/home/me/app");
    expect(pickedFolder("kdialog", 0, "/home/me/app\n")).toBe("/home/me/app");
  });

  it("returns null when zenity, kdialog or yad is cancelled", () => {
    expect(pickedFolder("zenity", 1, "")).toBeNull();
    expect(pickedFolder("kdialog", 1, "")).toBeNull();
  });

  it("returns the POSIX path that macOS prints", () => {
    expect(pickedFolder("osascript", 0, "/Users/me/app/\n")).toBe("/Users/me/app");
  });

  it("keeps the root folder", () => {
    expect(pickedFolder("zenity", 0, "/\n")).toBe("/");
  });
});
