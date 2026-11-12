/**
 * The agent loop shared by every kind of turn (planning, tasks, reviews, consults, direct chat): call the model with
 * the agent's tools, run the tool calls it makes, feed the results back, until a tool ends the turn or the model
 * answers in plain text.
 */
import type { Effort } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { complete, type Item, type LlmResult, type ToolCall } from "../llm/azure";
import { clip, UserError } from "../lib/util";
import { Denied, toFunction, type Stop, type Tool, type ToolContext } from "../tools/types";

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
}

export interface LoopResult { stop: Stop | null; text: string; rounds: number }

const MAX_CONTEXT_CHARS = 450_000;

/** Older tool outputs are shortened when the transcript grows too long; the latest rounds stay intact. */
function compact(input: Item[]) {
  let size = JSON.stringify(input).length;
  for (const item of input) {
    if (size <= MAX_CONTEXT_CHARS) return;
    if (item.type === "function_call_output" && typeof item.output === "string" && item.output.length > 1500) {
      size -= item.output.length - 1500;
      item.output = `${item.output.slice(0, 1200)}\n… [shortened to save context; run the tool again if you need it]`;
    }
  }
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
  for (let round = 1; round <= o.maxRounds; round++) {
    await o.events.beforeCall();
    compact(input);
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
      input.push({ type: "function_call_output", call_id: call.call_id, output: clip(r.output, 30_000) });
      if (r.image) images.push(r.image);
      if (r.stop) stop = r.stop;
    }
    if (stop) return { stop, text: lastText, rounds: round };
    if (images.length) input.push({ role: "user", content: [{ type: "input_text", text: "Screenshot from your last tool call:" }, ...images.slice(-2).map((url) => ({ type: "input_image", image_url: url }))] });
  }
  return { stop: null, text: lastText || "Stopped after the maximum number of tool rounds.", rounds: o.maxRounds };
}
