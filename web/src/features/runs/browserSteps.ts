/** Pure helpers behind the run's Browser tab: which agents browsed, what each step did, which screenshot to show. */
import type { BrowserAction } from "./runState";
import { browserVerb } from "./runState";

/** The live status the engine sets while a browser call runs ("Browser: click…"). */
export const isBrowsing = (activity?: string) => !!activity && activity.startsWith("Browser:");

/** Agents that used the browser, most recently active first. */
export function browserAgents(actions: BrowserAction[]): string[] {
  const last = new Map<string, number>();
  actions.forEach((a, i) => last.set(a.agent_id, i));
  return [...last.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** A human line for one step: "clicked “Start game”", "typed “hello” and pressed Enter", "opened http://…". */
export function describeAction(a: BrowserAction): string {
  const g = a.args ?? {};
  const verb = browserVerb(a.tool);
  const el = str(g.element) || str(g.ref) || str(g.target);
  switch (a.tool) {
    case "browser_navigate": return `${verb} ${str(g.url) || a.url}`;
    case "browser_click": case "browser_hover": return el ? `${verb} “${el}”` : verb;
    case "browser_type": return `${verb} “${str(g.text)}”${el ? ` into ${el}` : ""}${g.submit ? " and pressed Enter" : ""}`;
    case "browser_press_key": return `pressed ${str(g.key) || "a key"}`;
    case "browser_select_option": return `picked ${str(g.values)}${el ? ` in ${el}` : ""}`;
    case "browser_wait_for": return g.text ? `waited for “${str(g.text)}”` : g.time ? `waited ${str(g.time)}s` : verb;
    case "browser_evaluate": return `${verb}${g.function ? `: ${str(g.function).slice(0, 80)}` : ""}`;
    case "browser_fill_form": return Array.isArray(g.fields) ? `filled ${g.fields.length} field(s)` : verb;
    default: return verb;
  }
}

/** The screenshot that shows the tab right after `actions[index]`: its own, or the latest earlier one of the same agent. */
export function frameFor(actions: BrowserAction[], index: number): BrowserAction | null {
  const a = actions[index];
  if (!a) return null;
  for (let i = index; i >= 0; i--) if (actions[i].agent_id === a.agent_id && actions[i].frame) return actions[i];
  return null;
}
