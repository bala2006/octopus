import { describe, expect, it } from "vitest";
import { browserBadge } from "./SettingsPage";

describe("browserBadge", () => {
  it("is green only when a real browser rendered a page", () => {
    expect(browserBadge("ready")).toEqual({ label: "Browser working", variant: "success" });
    expect(browserBadge("server_ready").variant).toBe("warning"); // MCP server up is not "Running"
    expect(browserBadge("error")).toEqual({ label: "Can't launch", variant: "destructive" });
    expect(browserBadge(undefined).label).toBe("Starts on first use");
  });
});
