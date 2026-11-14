/**
 * The steps an agent takes, as the chat shows them: every thought and every tool call, in order, each with a short
 * plain-language title. Messages stay in the conversation. The steps one agent takes between two messages form one
 * group: a count line ("+ 2 commands, 1 read"), and one line on what the agent is doing.
 */

export type StepKind = "thought" | "read" | "write" | "command" | "browser" | "task" | "team" | "review" | "search" | "other";

export interface Step {
  id: string;
  seq: number;
  agent_id: string;
  kind: StepKind;
  title: string;
  /** The full thought, or the tool's output. Shown when the step is opened. */
  detail: string;
  status: "running" | "ok" | "failed";
}

export interface CallInfo {
  call_id: string;
  agent_id: string;
  tool: string;
  args: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tools whose output is a chat message or a question. The message already shows, so they add no step. */
const IN_CHAT = new Set(["reply_to_user", "ask_user", "ask_teammate", "start_work"]);

const BROWSER: Record<string, (a: Record<string, unknown>) => string> = {
  browser_navigate: (a) => `Opened ${clip(str(a.url) || "a page", 90)}`,
  browser_click: (a) => `Clicked ${clip(str(a.element) || str(a.ref) || "an element", 70)}`,
  browser_hover: (a) => `Hovered over ${clip(str(a.element) || str(a.ref) || "an element", 70)}`,
  browser_type: (a) => `Typed "${clip(str(a.text), 60)}"${str(a.element) ? ` into ${clip(str(a.element), 60)}` : ""}`,
  browser_press_key: (a) => `Pressed ${str(a.key) || "a key"}`,
  browser_snapshot: () => "Read the page",
  browser_take_screenshot: () => "Took a screenshot",
  browser_console_messages: () => "Checked the browser console",
  browser_wait_for: () => "Waited for the page",
};

/** The tool name the engine records for a browser call ("mcp:browser/browser_navigate") or the generic mcp_call. */
function mcpTarget(tool: string, args: Record<string, unknown>): { server: string; tool: string } | null {
  if (tool.startsWith("mcp:")) {
    const [server = "", name = ""] = tool.slice(4).split("/");
    return { server, tool: name };
  }
  if (tool === "mcp_call") return { server: str(args.server), tool: str(args.tool) };
  return null;
}

/** A short line for one tool call, or null when the call already shows in the conversation. */
export function describeCall(tool: string, args: Record<string, unknown>): { kind: StepKind; title: string } | null {
  const mcp = mcpTarget(tool, args);
  if (mcp?.server === "browser") {
    const describe = BROWSER[mcp.tool];
    return { kind: "browser", title: describe ? describe(args) : `Browser: ${mcp.tool.replace(/^browser_/, "").replace(/_/g, " ")}` };
  }
  if (mcp) return { kind: "other", title: `${mcp.server}: ${mcp.tool.replace(/_/g, " ")}` };
  if (IN_CHAT.has(tool)) return null;
  switch (tool) {
    case "read_file": return { kind: "read", title: `Read ${str(args.path) || "a file"}` };
    case "list_files": return { kind: "read", title: `Listed ${str(args.path) || "the project files"}` };
    case "search_project": return { kind: "search", title: `Searched the project for "${clip(str(args.query), 60)}"` };
    case "web_search": return { kind: "search", title: `Searched the web for "${clip(str(args.query), 60)}"` };
    case "fetch_url": return { kind: "search", title: `Fetched ${clip(str(args.url), 90)}` };
    case "write_file": return { kind: "write", title: `Wrote ${str(args.path) || "a file"}` };
    case "edit_file": return { kind: "write", title: `Edited ${str(args.path) || "a file"}` };
    case "move_file": return { kind: "write", title: `Moved ${str(args.from)} to ${str(args.to)}` };
    case "delete_file": return { kind: "write", title: `Deleted ${str(args.path) || "a file"}` };
    case "run_command": case "run_code": return { kind: "command", title: `Ran ${clip(str(args.command) || "a command", 90)}` };
    case "create_task": return { kind: "task", title: `Created task: ${clip(str(args.title), 90)}` };
    case "complete_task": return { kind: "task", title: `Finished a task: ${clip(str(args.summary), 90)}` };
    case "block_task": return { kind: "task", title: `Blocked a task: ${clip(str(args.reason), 90)}` };
    case "hire_agent": return { kind: "team", title: `Hired ${str(args.title) || str(args.role_key) || "an agent"}` };
    case "submit_review": return { kind: "review", title: args.verdict === "approve" ? "Approved the work" : "Requested changes" };
    case "remember": return { kind: "other", title: `Saved a note: ${clip(str(args.key), 60)}` };
    case "forget": return { kind: "other", title: `Removed a note: ${clip(str(args.key), 60)}` };
    default: return { kind: "other", title: tool.replace(/_/g, " ") };
  }
}

/** The first meaningful line of a thought, without markdown markers. */
function headline(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]+/g, "").trim()).find(Boolean) ?? "";
  return clip(line || "Thought", 140);
}

export function thoughtStep(seq: number, agent_id: string, text: string): Step {
  return { id: `thought-${seq}`, seq, agent_id, kind: "thought", title: headline(text), detail: text, status: "ok" };
}

/** The step a tool call adds, still running. Null for calls that show in the conversation instead. */
export function callStep(seq: number, call: CallInfo): Step | null {
  const d = describeCall(call.tool, call.args ?? {});
  return d ? { id: call.call_id, seq, agent_id: call.agent_id, kind: d.kind, title: d.title, detail: "", status: "running" } : null;
}

export function finishStep(step: Step, ok: boolean, output: string): Step {
  return { ...step, status: ok ? "ok" : "failed", detail: output };
}

const LABELS: Record<StepKind, [singular: string, plural: string]> = {
  thought: ["thought", "thoughts"],
  read: ["read", "reads"],
  write: ["file change", "file changes"],
  command: ["command", "commands"],
  browser: ["browser step", "browser steps"],
  task: ["task update", "task updates"],
  team: ["hire", "hires"],
  review: ["review", "reviews"],
  search: ["search", "searches"],
  other: ["tool", "tools"],
};

/**
 * The count line for a group: "+ 2 commands, 1 read, 1 tool", kinds in the order the group ran them. Thoughts are the
 * narration, so they count only when a group holds nothing else.
 */
export function countLine(steps: Step[]): string {
  const tools = steps.filter((s) => s.kind !== "thought");
  const counts = new Map<StepKind, number>();
  for (const s of tools.length ? tools : steps) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts = [...counts].map(([kind, n]) => `${n} ${LABELS[kind][n === 1 ? 0 : 1]}`);
  return `+ ${parts.join(", ")}`;
}
