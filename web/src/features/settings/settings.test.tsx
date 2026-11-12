import { describe, expect, it } from "vitest";
import { browserBadge, SECTIONS, sectionFromHash } from "./SettingsPage";

describe("browserBadge", () => {
  it("is green only when a real browser rendered a page", () => {
    expect(browserBadge("ready")).toEqual({ label: "Browser working", variant: "success" });
    expect(browserBadge("server_ready").variant).toBe("warning"); // MCP server up is not "Running"
    expect(browserBadge("error")).toEqual({ label: "Can't launch", variant: "destructive" });
    expect(browserBadge(undefined).label).toBe("Starts on first use");
  });
});

describe("settings sections", () => {
  it("labels the theme + currency section 'Preferences' but keeps the #appearance deep link", () => {
    const pref = SECTIONS.find(([k]) => k === "appearance");
    expect(pref?.[1]).toBe("Preferences");
    expect(sectionFromHash("#appearance")).toBe("appearance");
  });

  it("falls back to the first section for unknown or empty hashes", () => {
    expect(sectionFromHash("")).toBe("providers");
    expect(sectionFromHash("#preferences-old")).toBe("providers");
  });

  it("keeps every nav label short enough for one line", () => {
    for (const [, label] of SECTIONS) expect(label.length).toBeLessThanOrEqual(14);
  });
});
