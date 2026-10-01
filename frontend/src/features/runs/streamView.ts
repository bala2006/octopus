/**
 * Turns what an agent is streaming (tool arguments or a JSON action envelope, i.e. escaped JSON text) into something a
 * person can read while it is being written: "Writing src/game.js" with the code laid out line by line, "Message to Ben"
 * as a paragraph, and so on. Works on incomplete text: the last string is decoded as far as it has arrived.
 */
export type SegmentKind = "thought" | "code" | "message" | "command" | "status" | "text";
export interface Segment { kind: SegmentKind; title: string; body: string; language?: string }

/** Decode a JSON string that starts right after its opening quote; stops at the closing quote or the end of the input. */
export function readJsonString(src: string, start: number): { value: string; end: number; closed: boolean } {
  let out = "";
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return { value: out, end: i + 1, closed: true };
    if (ch !== "\\") { out += ch; i++; continue; }
    const e = src[i + 1];
    if (e === undefined) break; // escape not complete yet
    const simple: Record<string, string> = { n: "\n", t: "\t", r: "", '"': '"', "\\": "\\", "/": "/", b: "", f: "" };
    if (e in simple) { out += simple[e]; i += 2; continue; }
    if (e === "u") {
      const hex = src.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16) || 0x3f);
      i += 6;
      continue;
    }
    out += e;
    i += 2;
  }
  return { value: out, end: src.length, closed: false };
}

/** The value of the last `"field": "…"` in `src` (possibly still being written). */
export function lastField(src: string, field: string): string | undefined {
  const re = new RegExp(`"${field}"\\s*:\\s*"`, "g");
  let m: RegExpExecArray | null;
  let at = -1;
  while ((m = re.exec(src))) at = m.index + m[0].length;
  return at < 0 ? undefined : readJsonString(src, at).value;
}

const LANG: Record<string, string> = { js: "JavaScript", mjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", jsx: "JavaScript", py: "Python",
  html: "HTML", css: "CSS", json: "JSON", md: "Markdown", sh: "Shell", go: "Go", rs: "Rust", java: "Java", sql: "SQL", yml: "YAML", yaml: "YAML" };
const languageOf = (path = "") => LANG[path.split(".").pop()?.toLowerCase() ?? ""];

function actionSegment(action: string, src: string): Segment {
  const f = (k: string) => lastField(src, k);
  const path = f("path") ?? "";
  switch (action) {
    case "write_file": return { kind: "code", title: `${f("mode") === "append" ? "Appending to" : "Writing"} ${path || "a file"}`, body: f("content") ?? "", language: languageOf(path) };
    case "edit_file": return { kind: "code", title: `Editing ${path || "a file"}`, body: f("new_string") ?? "", language: languageOf(path) };
    case "send_message": return { kind: "message", title: `Message${f("to") ? ` to ${f("to")}` : ""}${f("type") ? ` (${f("type")!.replace(/_/g, " ")})` : ""}`, body: f("content") ?? "" };
    case "delegate": return { kind: "message", title: `Delegating${f("to") ? ` to ${f("to")}` : ""}`, body: [f("objective"), f("deliverable") && `Deliverable: ${f("deliverable")}`, f("done_when") && `Done when: ${f("done_when")}`].filter(Boolean).join("\n\n") };
    case "run_code": return { kind: "command", title: "Running a command", body: f("command") ?? "" };
    case "request_user_input": return { kind: "message", title: "Question for you", body: f("question") ?? "" };
    case "finish": return { kind: "message", title: "Wrapping up", body: f("summary") ?? "" };
    case "remember": return { kind: "status", title: `Remembering ${f("key") ?? ""}`.trim(), body: f("value") ?? "" };
    case "read_file": return { kind: "status", title: `Reading ${path || "a file"}`, body: "" };
    case "list_files": return { kind: "status", title: "Listing files", body: "" };
    case "search_project": return { kind: "status", title: `Searching for “${f("query") ?? ""}”`, body: "" };
    case "update_task_board": return { kind: "status", title: "Updating the task board", body: f("title") ?? "" };
    case "wait": return { kind: "status", title: "Waiting for teammates", body: "" };
    default: return { kind: "status", title: action.startsWith("mcp__") ? `Using ${action.split("__").slice(1).join(" / ")}` : action.replace(/_/g, " "), body: "" };
  }
}

/** All readable segments in a stream, in order (the last one is what's being written right now). */
export function humanizeStream(raw: string): Segment[] {
  const text = raw ?? "";
  const re = /"action"\s*:\s*"([\w-]+)"/g;
  const hits: { action: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) hits.push({ action: m[1], at: m.index });
  if (!hits.length) {
    const thought = lastField(text, "thought");
    if (thought !== undefined) return [{ kind: "thought", title: "Thinking", body: thought }];
    const plain = text.trimStart();
    if (!plain || plain.startsWith("{") || plain.startsWith("[")) return [];
    return [{ kind: "text", title: "Writing", body: plain }]; // the model's own words (native tool calling)
  }
  const segs: Segment[] = [];
  const head = text.slice(0, hits[0].at);
  const thought = lastField(head, "thought");
  if (thought) segs.push({ kind: "thought", title: "Thinking", body: thought });
  const lead = head.replace(/\{\s*"thought"[\s\S]*$/, "").trim();
  if (lead && !lead.startsWith("{")) segs.push({ kind: "text", title: "Writing", body: lead });
  hits.forEach((h, i) => segs.push(actionSegment(h.action, text.slice(h.at, i + 1 < hits.length ? hits[i + 1].at : text.length))));
  return segs;
}

/** The last `n` lines (code is shown from where it's being written). */
export function tailLines(body: string, n: number): string {
  const lines = body.replace(/\r/g, "").split("\n");
  return lines.length <= n ? body : lines.slice(-n).join("\n");
}

/**
 * Append a streamed delta while keeping the buffer bounded. Older calls are dropped first; for one very long call the
 * header (`{"action":…,"path":…,"content":"`) is kept and the content resumes at a line boundary, so the view can still
 * say what is being written and lay it out line by line.
 */
export function appendStream(prev: string, delta: string, cap = 16000): string {
  let text = (prev ?? "") + delta;
  if (text.length <= cap) return text;
  const at = text.lastIndexOf('{"action"');
  if (at > 0) text = text.slice(at);
  if (text.length <= cap) return text;
  const body = text.search(/"(content|new_string|objective|summary|thought)"\s*:\s*"/);
  const headerEnd = body >= 0 ? text.indexOf('"', text.indexOf(":", body)) + 1 : Math.min(400, text.length);
  const header = text.slice(0, headerEnd);
  let tail = text.slice(-(cap - header.length));
  const nl = tail.indexOf("\\n");
  if (nl >= 0) tail = tail.slice(nl + 2); // resume at the start of a line
  return header + "…\\n" + tail;
}
