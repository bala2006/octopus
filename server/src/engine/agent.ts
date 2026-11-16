/**
 * The agent loop shared by every kind of turn (planning, tasks, reviews, consults, direct chat): call the model with
 * the agent's tools, run the tool calls it makes, feed the results back, until a tool ends the turn or the model
 * answers in plain text.
 */
import type { Effort } from "@octopus/shared";
import { config } from "../config";
import type { Registry } from "../db/registry";
import { complete, contextWindow, type FunctionTool, type Item, type LlmResult, type ToolCall } from "../llm/azure";
import { spill } from "../lib/spill";
import { UserError } from "../lib/util";
import { Denied, toFunction, type Shown, type Stop, type Tool, type ToolContext } from "../tools/types";

export interface LoopEvents {
  text(delta: string): void;
  thinking(delta: string): void;
  thought(text: string): void;
  toolStart(call: { call_id: string; name: string }): void;
  toolArgs(callId: string, delta: string): void;
  toolCall(callId: string, name: string, args: Record<string, unknown>): void;
  toolResult(callId: string, name: string, ok: boolean, output: string, metrics?: import("../tools/types").ToolMetrics): void;
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
  /** Leading transcript items that summarizing must keep word for word: the brief and anything sent with it. */
  keepHead?: number;
  /** The tools in this turn's toolbox that end it (complete_task, submit_review, ...); the wrap-up and nudge name only these. */
  stopTools: string[];
  /** The prompt cache key of this agent's turns: conversation, agent and mode. */
  cacheKey?: string;
}

/** `exhausted`: the agent used every tool round without finishing. */
export interface LoopResult { stop: Stop | null; text: string; rounds: number; exhausted?: boolean }

/** Tokens the context window keeps free for the reply and the tool definitions. */
const REPLY_RESERVE = 32_000;
/** The transcript is compacted at this share of the window, when that is smaller than the reserve allows. */
const COMPACT_SHARE = 0.8;
/** The newest share of the compaction budget that stays word for word after a checkpoint. */
const KEEP_SHARE = 0.16;
const CHARS_PER_TOKEN = 4;
/** An image costs about this many tokens, whatever its size in characters. */
const IMAGE_TOKENS = 1_000;
/** In the transcript a checkpoint is written from, tool results longer than PRUNE_OVER keep only their head and tail. */
const PRUNE_OVER = 8_192;
const PRUNE_HEAD = 4_096;
const PRUNE_TAIL = 1_024;
/** A turn that has not finished is told to wrap up this many steps before its step limit (the last one counts as 1). */
const WRAP_UP_STEPS = 5;
/** Identical consecutive calls at these counts get a reminder that the agent is repeating itself. */
const REPEAT_REMINDERS = [3, 5, 8];
/** The wrap-up message, naming only the tools in this turn's toolbox that end it. */
function wrapUp(stopTools: string[]): string {
  return `You are almost out of steps for this turn. Stop exploring, testing and polishing. Call the tool that ends the turn now${endingList(stopTools)}, and say what is done and what is not verified. If the work cannot be finished as specified, say so in that tool.`;
}
function endingList(stopTools: string[]): string {
  return stopTools.length ? ` (${stopTools.join(", ")})` : "";
}
export const CHECKPOINT_REQUEST = `Write a checkpoint of your work so far. It replaces the earlier part of this conversation, so include everything you need to carry on without it:
## Primary request and intent: what the user asked for and what you were asked to do
## Key technical concepts: the stack, conventions and decisions that matter
## Files and code: each file you touched or relied on, with its exact path and what it holds
## Errors and fixes: each error met, its cause and how it was resolved
## Pending work: what is still to do, in order
## Current work: what you were doing when this checkpoint was written
## Next step: the single next action
## Critical context: values, names, commands and URLs you will need again
Be specific and complete; do not call any tool.`;

/** The transcript size, in tokens, at which the window is compacted for a given context window. */
export function compactAt(window: number): number {
  return Math.min(COMPACT_SHARE * window, window - REPLY_RESERVE);
}

function keepChars(window: number): number {
  return Math.round(KEEP_SHARE * compactAt(window) * CHARS_PER_TOKEN);
}

/** Estimated tokens of transcript items: characters over four, with each image counted as IMAGE_TOKENS. */
export function tokensOf(items: Item[]): number {
  let chars = 0;
  let images = 0;
  for (const item of items) {
    chars += JSON.stringify(item, (key, value) => {
      if (key !== "image_url") return value;
      images++;
      return undefined;
    }).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS;
}

/**
 * The transcript size: the input tokens the last response reported, plus an estimate for the items added since. Null
 * before the first response, and after a checkpoint has replaced part of the transcript.
 */
interface Measure { tokens: number; at: number }
function contextTokens(input: Item[], measured: Measure | null): number {
  return measured ? measured.tokens + tokensOf(input.slice(measured.at)) : tokensOf(input);
}

/** Whether a checkpoint could replace anything: whole steps lie between the head and the kept tail. */
export function compactable(input: Item[], head: number, window: number): boolean {
  return keptFrom(input, Math.max(1, head), keepChars(window)) !== null;
}

/** Drop the file-read entries whose output is gone. An entry with no position cannot be placed, so it goes too. */
function dropShown(shown: Shown, gone: (at: number) => boolean) {
  for (const [file, entry] of shown) if (entry.at === undefined || gone(entry.at)) shown.delete(file);
}

/**
 * The file-read entries a tool call created or changed now hold the content of its output, at `position`. A read that
 * extends an earlier version of the same content depends on that earlier output too, so the earlier position is kept.
 */
function tagShown(shown: Shown, before: Shown, position: number) {
  for (const [file, entry] of shown) {
    const prior = before.get(file);
    if (prior === entry) continue;
    const earlier = prior?.hash === entry.hash ? prior.at : undefined;
    entry.at = earlier === undefined ? position : Math.min(earlier, position);
  }
}

/**
 * Where the kept part of a transcript begins when summarizing: about `keepTail` characters from the end, moved back to
 * the start of a whole step (right after a finished one, never on a tool output), so no call loses its output or the
 * reasoning that produced it, and the newest step is always kept whole. Null when nothing worth summarizing lies
 * between the head and that point.
 */
export function keptFrom(input: Item[], head: number, keepTail: number): number | null {
  let start = input.length;
  for (let size = 0; start > head && size < keepTail; ) size += JSON.stringify(input[--start]).length;
  const begins = (i: number) => input[i]!.type !== "function_call_output" && (input[i - 1]!.type === "function_call_output" || input[i - 1]!.role === "user" || input[i]!.role === "user");
  while (start > head + 1 && start < input.length && !begins(start)) start--;
  return start <= head + 1 || start >= input.length ? null : start;
}

/** A long tool result in the transcript a checkpoint is written from: its head and tail, with a note in between. */
function prune(item: Item): Item {
  if (item.type !== "function_call_output" || typeof item.output !== "string" || item.output.length <= PRUNE_OVER) return item;
  return { ...item, output: `${item.output.slice(0, PRUNE_HEAD)}\n… [pruned to save context]\n${item.output.slice(-PRUNE_TAIL)}` };
}

/**
 * Replace the middle of a long transcript with a checkpoint the model writes. The request is the transcript, with the
 * middle's long tool results pruned, plus one question. Keeps the brief and the newest whole steps. Returns false when
 * there is nothing to replace, or when the checkpoint is not smaller than what it replaces.
 */
async function summarize(o: LoopOptions, functions: FunctionTool[], window: number): Promise<boolean> {
  const input = o.input;
  const head = Math.max(1, o.keepHead ?? 1);
  const start = keptFrom(input, head, keepChars(window));
  if (start === null) return false;
  const res = await complete(o.reg, {
    model: o.model, instructions: o.instructions,
    input: [...input.slice(0, head), ...input.slice(head, start).map(prune), ...input.slice(start), { role: "user", content: CHECKPOINT_REQUEST }],
    tools: functions, toolChoice: "none", effort: o.effort, signal: o.ctx.signal, maxOutputTokens: 8_000, promptCacheKey: o.cacheKey,
  });
  o.events.usage(res);
  const summary = res.text.trim();
  const checkpoint: Item = { role: "user", content: `<checkpoint>\n${summary}\n</checkpoint>\nThis checkpoint replaces your earlier work in this conversation. Continue from it. Files you read in the replaced part must be read again if you need their content; the rest of the transcript is unchanged.` };
  if (!summary || tokensOf([checkpoint]) >= tokensOf(input.slice(head, start))) return false;
  const before = tokensOf(input);
  // The checkpoint replaces the items from `head` to `start`. Their outputs are gone, and the entries after them move up.
  dropShown(o.ctx.shown, (at) => at >= head && at < start);
  for (const entry of o.ctx.shown.values()) if (entry.at !== undefined && entry.at >= start) entry.at -= start - head - 1;
  input.splice(head, start - head, checkpoint);
  o.events.thought(`Summarized earlier work to keep the context focused (${Math.round(before / 1000)}k → ${Math.round(tokensOf(input) / 1000)}k tokens).`);
  return true;
}

/** The model's arguments, or the parse failure that has to be reported back to it. */
function parseArgs(call: ToolCall): { args: Record<string, unknown> } | { error: string } {
  const raw = call.arguments || "{}";
  try {
    let v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: `${call.name} needs one JSON object, not ${Array.isArray(v) ? "an array" : typeof v}` };
    // Strict schemas express "this property is optional" as null: drop those keys before validation.
    if (config.strictTools) v = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null));
    return { args: v as Record<string, unknown> };
  } catch (e) {
    return { error: `the arguments were not valid JSON (${(e as Error).message}). Send one JSON object. Received: ${raw.slice(0, 300)}` };
  }
}

async function runCall(o: LoopOptions, call: ToolCall, byName: Map<string, Tool>): Promise<{ output: string; ok: boolean; image?: string; stop?: Stop; metrics?: import("../tools/types").ToolMetrics }> {
  const tool = byName.get(call.name);
  const parsedArgs = parseArgs(call);
  if ("error" in parsedArgs) {
    o.events.toolCall(call.call_id, call.name, { raw: call.arguments.slice(0, 300) });
    return { output: `Could not read the call to ${call.name}: ${parsedArgs.error}`, ok: false };
  }
  const args = parsedArgs.args;
  o.events.toolCall(call.call_id, call.name, args);
  if (!tool) return { output: `There is no tool called ${call.name}. Available: ${[...byName.keys()].join(", ")}`, ok: false };
  const parsed = tool.args.safeParse(args);
  if (!parsed.success) return { output: `Invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}. Arguments received: ${call.arguments.slice(0, 300) || "(none)"}`, ok: false };
  try {
    const r = await tool.run(o.ctx, parsed.data, call.call_id);
    return { output: r.text, ok: r.ok !== false, image: r.image, stop: r.stop, metrics: r.metrics };
  } catch (e) {
    if (o.ctx.signal.aborted) throw e;
    if (e instanceof Denied) return { output: `Not allowed: ${e.message}`, ok: false };
    if (e instanceof UserError) return { output: e.message, ok: false };
    return { output: `${call.name} failed: ${(e as Error).message}`, ok: false };
  }
}

export async function agentLoop(o: LoopOptions): Promise<LoopResult> {
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const functions = o.tools.map((t) => toFunction(t, config.strictTools));
  const input = o.input;
  const window = contextWindow(o.reg);
  let nudged = false;
  let lastText = "";
  let lastCall = "";
  let repeats = 0;
  let measured: Measure | null = null;
  /** The screenshot message for the next model call only. It is not stored, so a stored transcript never resends an image. */
  let pending: Item | null = null;
  /** Once a checkpoint is refused or fails in this turn, the turn does not try again: each try is a model call. */
  let compactionRefused = false;
  for (let round = 1; round <= o.maxRounds; round++) {
    if (o.requireStop && round === o.maxRounds - WRAP_UP_STEPS + 1) input.push({ role: "user", content: wrapUp(o.stopTools) });
    await o.events.beforeCall();
    if (o.inbox?.length) input.push({ role: "user", content: o.inbox.splice(0).join("\n\n") });
    if (!compactionRefused && contextTokens(input, measured) > compactAt(window)) {
      let compacted = false;
      try { compacted = await summarize(o, functions, window); } catch (e) { if (o.ctx.signal.aborted) throw e; }
      if (compacted) measured = null;
      else compactionRefused = true;
    }
    const res = await complete(o.reg, {
      model: o.model, instructions: o.instructions, input: pending ? [...input, pending] : input, tools: functions, effort: o.effort, signal: o.ctx.signal,
      maxOutputTokens: 48_000, promptCacheKey: o.cacheKey,
    }, {
      onText: o.events.text, onThinking: o.events.thinking, onToolStart: o.events.toolStart, onToolArgs: o.events.toolArgs,
    });
    pending = null;
    measured = { tokens: res.usage.input, at: input.length };
    o.events.usage(res);
    if (res.thought) o.events.thought(res.thought);
    input.push(...res.output);
    if (res.text.trim()) lastText = res.text.trim();
    if (!res.calls.length) {
      if (res.incomplete === "max_output_tokens") { input.push({ role: "user", content: "Your reply was cut off. Continue, in smaller steps." }); continue; }
      if (!o.requireStop || nudged) return { stop: null, text: lastText, rounds: round };
      nudged = true;
      input.push({ role: "user", content: `Continue working with your tools. When the task is finished and verified, call the tool that ends it${endingList(o.stopTools)}.` });
      continue;
    }
    let stop: Stop | undefined;
    const images: string[] = [];
    const shots: string[] = [];
    for (const call of res.calls) {
      if (stop) { input.push({ type: "function_call_output", call_id: call.call_id, output: "Skipped: the turn already ended." }); continue; }
      const position = input.length; // where this call's output goes
      const shownBefore = new Map(o.ctx.shown);
      const r = await runCall(o, call, byName);
      tagShown(o.ctx.shown, shownBefore, position);
      o.events.toolResult(call.call_id, call.name, r.ok, r.output, r.metrics);
      const kept = spill(o.ctx.fs, call.call_id, r.output);
      // A spilled output holds only its head and tail, so the file it came from is not in the transcript.
      if (kept.path) dropShown(o.ctx.shown, (at) => at === position);
      input.push({ type: "function_call_output", call_id: call.call_id, output: kept.text });
      if (r.image) {
        images.push(r.image);
        shots.push(`Screenshot taken: ${r.output}. The image was shown once to the model when it was taken.`);
      }
      if (r.stop) stop = r.stop;
      const sig = `${call.name}:${call.arguments}`;
      repeats = sig === lastCall ? repeats + 1 : 1;
      lastCall = sig;
    }
    if (stop) return { stop, text: lastText, rounds: round };
    if (REPEAT_REMINDERS.includes(repeats)) {
      input.push({ role: "user", content: `You have made the same ${lastCall.split(":")[0]} call ${repeats} times in a row with identical arguments, and it keeps giving the same result. Change your approach: try something different, ask a teammate, or finish with what you have.` });
    }
    if (shots.length) {
      input.push({ role: "user", content: shots.join("\n") });
      pending = { role: "user", content: [{ type: "input_text", text: "Screenshot from your last tool call:" }, ...images.map((url) => ({ type: "input_image", image_url: url }))] };
    }
  }
  return { stop: null, text: lastText, rounds: o.maxRounds, exhausted: true };
}
