/** Pure helpers behind the run's Browser tab: which agents browsed, what each step did, which screenshot to show, and what it printed. */
import type { BrowserAction } from "./runState";
import { browserVerb } from "./runState";

export type ConsoleLevel = "error" | "warning" | "info";
export type ConsoleLine = { level: ConsoleLevel; text: string; where?: string };

/** The live status the engine sets while a browser call runs ("Browser: click."). */
export const isBrowsing = (activity?: string) => !!activity && activity.startsWith("Browser:");

/** Agents that used the browser, most recently active first. */
export function browserAgents(actions: BrowserAction[]): string[] {
  const last = new Map<string, number>();
  actions.forEach((a, i) => last.set(a.agent_id, i));
  return [...last.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** A human line for one step: "clicked "Start game"", "typed "hello" and pressed Enter", "opened http://.". */
export function describeAction(a: BrowserAction): string {
  const g = a.args ?? {};
  const verb = browserVerb(a.tool);
  const el = str(g.element) || str(g.ref) || str(g.target);
  switch (a.tool) {
    case "browser_navigate": return `${verb} ${str(g.url) || a.url}`;
    case "browser_click": case "browser_hover": return el ? `${verb} \u201C${el}\u201D` : verb;
    case "browser_type": return `${verb} \u201C${str(g.text)}\u201D${el ? ` into ${el}` : ""}${g.submit ? " and pressed Enter" : ""}`;
    case "browser_press_key": return `pressed ${str(g.key) || "a key"}`;
    case "browser_select_option": return `picked ${str(g.values)}${el ? ` in ${el}` : ""}`;
    case "browser_wait_for": return g.text ? `waited for \u201C${str(g.text)}\u201D` : g.time ? `waited ${str(g.time)}s` : verb;
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

/** The Playwright MCP tool that prints console messages. The other browser tools print no console entries. */
const CONSOLE_TOOL = "browser_console_messages";
/** One entry as the tool prints it: "[LOG] text @ url:line". The label is the browser's console type in capitals. */
const ENTRY = /^\[([A-Z]+)\] ?(.*)$/;
/** An uncaught page error prints without a label, starting with its error name: "TypeError: x is not a function". */
const PAGE_ERROR = /^(?:Uncaught\s+)?[A-Za-z]*Error\b/;
/** The " @ url:line" the tool appends to the end of an entry. */
const WHERE = /^([\s\S]*) @ (\S*):(\d+)$/;

function levelOf(label: string): ConsoleLevel {
  if (label === "ERROR" || label === "ASSERT") return "error";
  if (label === "WARNING") return "warning";
  return "info";
}

function splitWhere(line: ConsoleLine): ConsoleLine {
  const match = WHERE.exec(line.text);
  if (!match) return line;
  const [, text, url, lineNo] = match;
  return { ...line, text: text!, where: url ? `${url}:${lineNo}` : `line ${lineNo}` };
}

/**
 * The console messages a step printed, in order. The tool's "### Result" section holds them. A message can run over
 * several lines, so a line with no label continues the message above it, except an uncaught error, which is its own entry.
 */
export function consoleLines(action: BrowserAction): ConsoleLine[] {
  if (action.tool !== CONSOLE_TOOL || !action.output) return [];
  const entries: ConsoleLine[] = [];
  for (const raw of action.output.split("\n")) {
    if (raw.startsWith("### ")) {
      if (raw.trim() === "### Result") continue;
      break; // the page and events sections after the messages
    }
    const entry = ENTRY.exec(raw);
    if (entry) entries.push({ level: levelOf(entry[1]!), text: entry[2]! });
    else if (PAGE_ERROR.test(raw)) entries.push({ level: "error", text: raw });
    else if (entries.length && raw.trim()) entries[entries.length - 1]!.text += `\n${raw}`;
  }
  return entries.map(splitWhere);
}

/**
 * Console errors and warnings one agent's console calls printed, for the summary above the list. Each call prints the
 * messages since the last navigation, so the same message can appear in many calls. Each distinct message counts once.
 */
export function consoleTotals(actions: BrowserAction[], agentId: string): { errors: number; warnings: number } {
  const totals = { errors: 0, warnings: 0 };
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.agent_id !== agentId) continue;
    for (const line of consoleLines(action)) {
      const key = `${line.level}\n${line.text}\n${line.where ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (line.level === "error") totals.errors += 1;
      else if (line.level === "warning") totals.warnings += 1;
    }
  }
  return totals;
}

/** The host of a page's address, or "" when there is none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The clock time of a step, or "" when the event carried none. */
export function timeOf(ts?: string): string {
  if (!ts) return "";
  const when = new Date(ts);
  return Number.isNaN(when.getTime()) ? "" : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
