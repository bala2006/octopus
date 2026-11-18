/**
 * The steps an agent takes, as the chat shows them: every thought and every tool call, in order, each with a short
 * plain-language title. Messages stay in the conversation. The steps one agent takes between two messages form one
 * group: each thought, then the activity it led to.
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
  /** When the step's event happened, as the server sends it (UTC, no zone). */
  ts?: string;
  /** For an edit or a write: the file, and the lines the call added and removed. */
  file?: { path: string; added: number; removed: number };
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
  // Browser tools arrive under their own names, and also as mcp:browser/<name> through the MCP proxy.
  const mcp = mcpTarget(tool, args) ?? (tool.startsWith("browser_") ? { server: "browser", tool } : null);
  if (mcp?.server === "browser") {
    const describe = BROWSER[mcp.tool];
    return { kind: "browser", title: describe ? describe(args) : `Browser: ${mcp.tool.replace(/^browser_/, "").replace(/_/g, " ")}` };
  }
  if (mcp) return { kind: "other", title: `${mcp.server}: ${mcp.tool.replace(/_/g, " ")}` };
  if (IN_CHAT.has(tool)) return null;
  switch (tool) {
    case "read_file": return { kind: "read", title: `Read ${str(args.path) || "a file"}` };
    case "glob": return { kind: "read", title: `Listed ${str(args.pattern) || "the project files"}` };
    case "grep": return { kind: "search", title: `Searched the project for "${clip(str(args.pattern), 60)}"` };
    case "web_search": return { kind: "search", title: `Searched the web for "${clip(str(args.query), 60)}"` };
    case "fetch_url": return { kind: "search", title: `Fetched ${clip(str(args.url), 90)}` };
    case "write_file": return { kind: "write", title: `Wrote ${str(args.path) || "a file"}` };
    case "edit_file": return { kind: "write", title: `Edited ${str(args.path) || "a file"}` };
    case "move_file": return { kind: "write", title: `Moved ${str(args.from)} to ${str(args.to)}` };
    case "delete_file": return { kind: "write", title: `Deleted ${str(args.path) || "a file"}` };
    case "shell": case "run_code": return { kind: "command", title: clip(str(args.command) || "a command", 90) };
    case "create_task": return { kind: "task", title: `Created task: ${clip(str(args.title), 90)}` };
    case "complete_task": return { kind: "task", title: `Finished a task: ${clip(str(args.summary), 90)}` };
    case "block_task": return { kind: "task", title: `Blocked a task: ${clip(str(args.reason), 90)}` };
    case "hire_agent": return { kind: "team", title: `Hired ${str(args.title) || str(args.role_key) || "an agent"}` };
    case "submit_review": return { kind: "review", title: args.verdict === "approve" ? "Approved the work" : "Requested changes" };
    case "remember": return { kind: "other", title: `Saved a note: ${clip(str(args.key), 60)}` };
    case "forget": return { kind: "other", title: `Removed a note: ${clip(str(args.key), 60)}` };
    case "skill": return { kind: "read", title: str(args.name) ? `Loaded the ${str(args.name)} skill` : "Loaded a skill" };
    case "todo_write": return { kind: "task", title: "Updated the todo list" };
    case "set_requirements": return { kind: "task", title: "Set the requirements" };
    case "cut_requirement": return { kind: "task", title: "Cut a requirement" };
    case "amend_task": return { kind: "task", title: "Changed a task" };
    case "start_dev_server": return { kind: "command", title: "Started the dev server" };
    case "explore": return { kind: "search", title: "Asked the explorer a question" };
    case "submit_acceptance": return { kind: "review", title: "Checked the result against the requirements" };
    default: return { kind: "other", title: tool.replace(/_/g, " ") };
  }
}

/** The first meaningful line of a thought, without markdown markers. */
function headline(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]+/g, "").trim()).find(Boolean) ?? "";
  return clip(line || "Thought", 140);
}

export function thoughtStep(seq: number, agent_id: string, text: string, ts?: string): Step {
  return { id: `thought-${seq}`, seq, agent_id, kind: "thought", title: headline(text), detail: text, status: "ok", ts };
}

/** The step a tool call adds, still running. Null for calls that show in the conversation instead. */
export function callStep(seq: number, call: CallInfo, ts?: string): Step | null {
  const d = describeCall(call.tool, call.args ?? {});
  return d ? { id: call.call_id, seq, agent_id: call.agent_id, kind: d.kind, title: d.title, detail: "", status: "running", ts, file: fileChange(call.tool, call.args ?? {}) } : null;
}

export function finishStep(step: Step, ok: boolean, output: string): Step {
  return { ...step, status: ok ? "ok" : "failed", detail: output };
}

const VERB: Partial<Record<StepKind, string>> = {
  read: "read files", write: "edited files", command: "ran commands", browser: "used the browser", search: "searched",
  task: "updated tasks", team: "hired", review: "reviewed", other: "used tools",
};

/** What a run of tool steps did, in the order they ran, as one line: "Read files, ran commands". */
export function activitySummary(steps: Step[]): string {
  const kinds: StepKind[] = [];
  for (const s of steps) if (s.kind !== "thought" && !kinds.includes(s.kind)) kinds.push(s.kind);
  const text = kinds.map((k) => VERB[k] ?? "used tools").join(", ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

const lineCount = (text: unknown) => (typeof text === "string" && text.length ? text.split("\n").length : 0);

/** The file an edit or a write changed. A write adds its whole content; an edit swaps its old snippet for its new one. */
function fileChange(tool: string, args: Record<string, unknown>): Step["file"] {
  const path = str(args.path);
  if (!path) return undefined;
  if (tool === "write_file") return { path, added: lineCount(args.content), removed: 0 };
  if (tool === "edit_file") return { path, added: lineCount(args.new_string), removed: lineCount(args.old_string) };
  return undefined;
}

export interface FileTotal { path: string; added: number; removed: number }

/** The files a run of steps changed, in the order each was first changed, with the lines added and removed across its edits. Failed edits changed nothing. */
export function fileTotals(steps: Step[]): FileTotal[] {
  const totals = new Map<string, FileTotal>();
  for (const s of steps) {
    if (!s.file || s.status === "failed") continue;
    const t = totals.get(s.file.path) ?? { path: s.file.path, added: 0, removed: 0 };
    t.added += s.file.added;
    t.removed += s.file.removed;
    totals.set(s.file.path, t);
  }
  return [...totals.values()];
}

/** A run of consecutive file changes, or a run of other steps, in the order they ran. */
export type Segment = { kind: "files" | "actions"; steps: Step[] };

export function segmentsOf(steps: Step[]): Segment[] {
  const out: Segment[] = [];
  for (const s of steps) {
    const kind = s.file && s.status !== "failed" ? "files" : "actions";
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.steps.push(s);
    else out.push({ kind, steps: [s] });
  }
  return out;
}

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[`*])/;

/**
 * A thought as readable paragraphs. Its own blank-line breaks stay; a paragraph longer than `maxChars` is split between
 * sentences into chunks of about that size, so a long thought reads as short paragraphs.
 */
export function narrationParagraphs(text: string, maxChars = 260): string[] {
  const out: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const paragraph = block.trim();
    if (!paragraph) continue;
    if (paragraph.length <= maxChars) {
      out.push(paragraph);
      continue;
    }
    let chunk = "";
    for (const sentence of paragraph.split(SENTENCE_BREAK)) {
      if (chunk && `${chunk} ${sentence}`.length > maxChars) {
        out.push(chunk);
        chunk = sentence;
      } else {
        chunk = chunk ? `${chunk} ${sentence}` : sentence;
      }
    }
    if (chunk) out.push(chunk);
  }
  return out;
}

/** One thought and the tool steps that followed it. */
export interface Phase {
  key: string;
  /** The thought that opened the phase. Null for tool steps that ran before any thought. */
  thought: Step | null;
  steps: Step[];
}

/**
 * Splits one agent's steps into phases. Each thought opens a phase, and the tool steps after it belong to that phase.
 * Tool steps before the first thought form a phase with no thought.
 */
export function phasesOf(steps: Step[]): Phase[] {
  const phases: Phase[] = [];
  for (const step of steps) {
    if (step.kind === "thought") {
      phases.push({ key: step.id, thought: step, steps: [] });
      continue;
    }
    if (!phases.length) phases.push({ key: `lead-${step.id}`, thought: null, steps: [] });
    phases[phases.length - 1]!.steps.push(step);
  }
  return phases;
}