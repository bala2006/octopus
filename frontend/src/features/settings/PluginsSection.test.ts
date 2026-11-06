import { describe, expect, it } from "vitest";
import type { PluginOut } from "@/types";
import { groupPlugins, SLOT_LABELS, stateBadge } from "./PluginsSection";
import { SECTIONS } from "./SettingsPage";

const plugin = (over: Partial<PluginOut>): PluginOut => ({
  id: "tool.web", title: "Web tools", description: "web_search and calculate.", slot: "tool", kind: "tool family", version: "1.0.0", status: "built",
  required: false, enabled: true, state: "registered", error: "", health: { state: "ok", detail: "" }, provides: ["tools.web"], requires: [],
  optional: [], permissions: ["network"], emits: [], ui: [], start: "eager", sdk: ">=1.0,<2", dependents: [], applies: "now", ...over,
});

describe("plugins section", () => {
  it("is a settings section with a short label", () => {
    expect(SECTIONS.find(([key]) => key === "plugins")?.[1]).toBe("Plugins");
  });

  it("groups plugins by slot in the architecture's order and puts unknown slots last", () => {
    const groups = groupPlugins([plugin({ id: "x.y", slot: "mystery" }), plugin({ id: "tool.web" }), plugin({ id: "kernel.runs", slot: "kernel" })]);
    expect(groups.map(([slot]) => slot)).toEqual(["kernel", "tool", "mystery"]);
    expect(SLOT_LABELS.tool).toBe("Tools");
  });

  it("filters by id, title and capability", () => {
    const list = [plugin({}), plugin({ id: "service.browser", title: "Agent browser", slot: "service", provides: ["browser.sessions"] })];
    expect(groupPlugins(list, "browser.sessions").flatMap(([, items]) => items.map((p) => p.id))).toEqual(["service.browser"]);
    expect(groupPlugins(list, "WEB TOOLS").flatMap(([, items]) => items.map((p) => p.id))).toEqual(["tool.web"]);
    expect(groupPlugins(list, "nothing like this")).toEqual([]);
  });

  it("shows failed and blocked before off, and planned plugins as planned", () => {
    expect(stateBadge(plugin({ state: "failed" }))).toEqual({ label: "Failed", variant: "destructive" });
    expect(stateBadge(plugin({ state: "blocked", enabled: true })).label).toBe("Blocked");
    expect(stateBadge(plugin({ enabled: false, state: "disabled" })).label).toBe("Off");
    expect(stateBadge(plugin({ status: "planned" })).label).toBe("Planned");
    expect(stateBadge(plugin({ health: { state: "degraded", detail: "slow" } })).variant).toBe("warning");
    expect(stateBadge(plugin({})).label).toBe("On");
  });
});
