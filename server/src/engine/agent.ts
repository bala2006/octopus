/**
 * The agent loop shared by every kind of turn (planning, tasks, reviews, consults, direct chat): call the model with
 * the agent's tools, run the tool calls it makes, feed the results back, until a tool ends the turn or the model
 * answers in plain text.
 */
import type { Effort } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { complete, type FunctionTool, type Item, type LlmResult, type ToolCall } from "../llm/azure";
import { clip, UserError } from "../lib/util";
import { Denied, MAX_TOOL_OUTPUT, toFunction, type Stop, type Tool, type ToolContext } from "../tools/types";

export interface LoopEvents {
  text(delta: string): void;
  thinking(delta: string): void;
  thought(text: string): void;
  toolStart(call: { call_id: string; name: string }): void;
  toolArgs(callId: string, delta: string): void;
  toolCall(callId: string, name: string, args: Record<string, unknown>): void;
  toolResult(callId: string, name: string, ok: boolean, output: string): void;
  usage(r: LlmResult): void;
  /** Called before every model call; throw to stop (budget, cancellation). Await to pause. */
  beforeCall(): Promise<void>;
}

export interface LoopOptions {
  reg: Registry;
  model: string;
  effort: Effort | undefined;
  instructions: string;
  input: Item[];
  tools: Tool[];
  ctx: ToolContext;
  events: LoopEvents;
  maxRounds: number;
  /** Nudge once when the model stops without calling a finishing tool. */
  requireStop: boolean;
  /** Messages for the agent from outside its turn (the lead amending its task), delivered before its next step. */
  inbox?: string[];
}

/** `exhausted`: the agent used every tool round without finishing. */
export interface LoopResult { stop: Stop | null; text: string; rounds: number; exhausted?: boolean }

/**
 * How big a transcript may grow. Past `summarizeAt` characters the older part is replaced by a checkpoint the model
 * writes itself, keeping the brief and the latest `keepTail` characters word for word; the work goes on without a cut.
 * `truncateAt` is the last resort if summarizing fails. Mutable so tests can make them small.
 */
export const contextLimits = { summarizeAt: 300_000, keepTail: 60_000, truncateAt: 450_000 };
/** A turn that has not finished is told to wrap up this many steps before its step limit (the last one counts as 1). */
const WRAP_UP_STEPS = 5;
const WRAP_UP = "You are almost out of steps for this turn. Stop exploring, testing and polishing. Call the tool that ends the turn now (complete_task, submit_review, start_work or reply_to_user), and say what is done and what is not verified. If the work cannot be finished as specified, say so in that tool.";
/** Identical consecutive calls at these counts get a reminder that the agent is repeating itself. */
const REPEAT_REMINDERS = [3, 5, 8];
export const CHECKPOINT_REQUEST = `Write a checkpoint of your work so far. It replaces the earlier part of this conversation, so include everything you need to carry on without it:
## Goal: the task and its acceptance criteria, in a few lines
## Done: what you built or changed, file by file, with the decisions behind it
## Facts: interfaces, names, commands, URLs and values you rely on
## Problems: errors met and how they were resolved, or what is still failing
## Next: the exact next steps
Be specific and complete; do not call any tool.`;

/** Older tool outputs are shortened when the transcript grows too long; the latest rounds stay intact. Returns whether anything was shortened. */
function truncate(input: Item[]): boolean {
  let size = JSON.stringify(input).length;
  let changed = false;
  for (const item of input) {
    if (size <= contextLimits.truncateAt) break;
    if (item.type === "function_call_output" && typeof item.output === "string" && item.output.length > 1500) {
      size -= item.output.length - 1500;
      item.output = `${item.output.slice(0, 1200)}\n… [shortened to save context; run the tool again if you need it]`;
      changed = true;
    }
  }
  return changed;
}

/**
 * Replace the middle of a long transcript with a checkpoint the model writes. The request is the transcript plus one
 * question, so the cached prefix is reused. Keeps the brief (item 0) and a recent tail that starts on a whole step.
 * Returns whether it compacted.
 */
async function summarize(o: LoopOptions, functions: FunctionTool[]): Promise<boolean> {
  const input = o.input;
  let start = input.length;
  for (let size = 0; start > 1 && size < contextLimits.keepTail; ) size += JSON.stringify(input[--start]).length;
  while (start < input.length && input[start]!.type === "function_call_output") start++;
  if (start <= 2) return false;
  const res = await complete(o.reg, {
    model: o.model, instructions: o.instructions, input: [...input, { role: "user", content: CHECKPOINT_REQUEST }], tools: functions, toolChoice: "none",
    effort: o.effort, signal: o.ctx.signal, maxOutputTokens: 8_000,
  });
  o.events.usage(res);
  const summary = res.text.trim();
  if (!summary) return false;
  const before = JSON.stringify(input).length;
  input.splice(1, start - 1, { role: "user", content: `<checkpoint>\n${summary}\n</checkpoint>\nThis checkpoint replaces your earlier work in this conversation. Continue from it; files you read before must be read again if you need their content.` });
  o.events.thought(`Summarized earlier work to keep the context focused (${Math.round(before / 1000)}k → ${Math.round(JSON.stringify(input).length / 1000)}k characters).`);
  return true;
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try { const v = JSON.parse(call.arguments || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

async function runCall(o: LoopOptions, call: ToolCall, byName: Map<string, Tool>): Promise<{ output: string; ok: boolean; image?: string; stop?: Stop }> {
  const tool = byName.get(call.name);
  const args = parseArgs(call);
  o.events.toolCall(call.call_id, call.name, args);
  if (!tool) return { output: `There is no tool called ${call.name}. Available: ${[...byName.keys()].join(", ")}`, ok: false };
  const parsed = tool.args.safeParse(args);
  if (!parsed.success) return { output: `Invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`, ok: false };
  try {
    const r = await tool.run(o.ctx, parsed.data, call.call_id);
    return { output: r.text, ok: r.ok !== false, image: r.image, stop: r.stop };
  } catch (e) {
    if (o.ctx.signal.aborted) throw e;
    if (e instanceof Denied) return { output: `Not allowed: ${e.message}`, ok: false };
    if (e instanceof UserError) return { output: e.message, ok: false };
    return { output: `${call.name} failed: ${(e as Error).message}`, ok: false };
  }
}

export async function agentLoop(o: LoopOptions): Promise<LoopResult> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const functions = o.tools.map(toFunction);
  const input = o.input;
  let nudged = false;
  let lastText = "";
  let lastCall = "";
  let repeats = 0;
  for (let round = 1; round <= o.maxRounds; round++) {
    if (o.requireStop && round === o.maxRounds - WRAP_UP_STEPS + 1) input.push({ role: "user", content: WRAP_UP });
    await o.events.beforeCall();
    if (o.inbox?.length) input.push({ role: "user", content: o.inbox.splice(0).join("\n\n") });
    // A summarized or shortened read no longer holds the file, so the next read of it must return the content again.
    if (JSON.stringify(input).length > contextLimits.summarizeAt) {
      let done = false;
      try { done = await summarize(o, functions); } catch (e) { if (o.ctx.signal.aborted) throw e; }
      if (done) o.ctx.shown.clear();
    }
    if (truncate(input)) o.ctx.shown.clear();
    const res = await complete(o.reg, {
      model: o.model, instructions: o.instructions, input, tools: functions, effort: o.effort, signal: o.ctx.signal,
      maxOutputTokens: 48_000,
    }, {
      onText: o.events.text, onThinking: o.events.thinking, onToolStart: o.events.toolStart, onToolArgs: o.events.toolArgs,
    });
    o.events.usage(res);
    if (res.thought) o.events.thought(res.thought);
    input.push(...res.output);
    if (res.text.trim()) lastText = res.text.trim();
    if (!res.calls.length) {
      if (res.incomplete === "max_output_tokens") { input.push({ role: "user", content: "Your reply was cut off. Continue, in smaller steps." }); continue; }
      if (!o.requireStop || nudged) return { stop: null, text: lastText, rounds: round };
      nudged = true;
      input.push({ role: "user", content: "Continue working with your tools. When the task is finished and verified, call the tool that ends it (complete_task, submit_review, start_work or reply_to_user)." });
      continue;
    }
    let stop: Stop | undefined;
    const images: string[] = [];
    for (const call of res.calls) {
      if (stop) { input.push({ type: "function_call_output", call_id: call.call_id, output: "Skipped: the turn already ended." }); continue; }
      const r = await runCall(o, call, byName);
      o.events.toolResult(call.call_id, call.name, r.ok, r.output);
      input.push({ type: "function_call_output", call_id: call.call_id, output: clip(r.output, MAX_TOOL_OUTPUT) });
      if (r.image) images.push(r.image);
      if (r.stop) stop = r.stop;
      const sig = `${call.name}:${call.arguments}`;
      repeats = sig === lastCall ? repeats + 1 : 1;
      lastCall = sig;
    }
    if (stop) return { stop, text: lastText, rounds: round };
    if (REPEAT_REMINDERS.includes(repeats)) {
      input.push({ role: "user", content: `You have made the same ${lastCall.split(":")[0]} call ${repeats} times in a row with identical arguments, and it keeps giving the same result. Change your approach: try something different, ask a teammate, or finish with what you have.` });
    }
    if (images.length) input.push({ role: "user", content: [{ type: "input_text", text: "Screenshot from your last tool call:" }, ...images.slice(-2).map((url) => ({ type: "input_image", image_url: url }))] });
  }
  return { stop: null, text: lastText, rounds: o.maxRounds, exhausted: true };
}
