/**
 * Azure OpenAI over the v1 Responses API: streaming, native tool calls, reasoning summaries and exact usage. Stateless
 * (`store: false`): encrypted reasoning items are returned and replayed between tool rounds. When a deployment rejects a
 * parameter the call is retried without it, and that is remembered per deployment.
 */
import type { Effort, ProviderOptions } from "@octopus/shared";
import { config } from "../config";
import type { Registry } from "../db/registry";
import { decrypt } from "../lib/secrets";
import { run } from "../lib/proc";
import { sleep, UserError } from "../lib/util";
import { priceUsage, type TokenUsage } from "./pricing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Item = Record<string, any>;
export interface FunctionTool { type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict?: boolean }
export interface ToolCall { call_id: string; name: string; arguments: string }
export interface LlmRequest {
  model: string;
  instructions: string;
  input: Item[];
  tools?: FunctionTool[];
  effort?: Effort;
  maxOutputTokens?: number;
  toolChoice?: "auto" | "required" | "none";
  signal?: AbortSignal;
}
export interface StreamHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (call: { call_id: string; name: string }) => void;
  onToolArgs?: (callId: string, delta: string) => void;
}
export interface LlmResult { text: string; thought: string; calls: ToolCall[]; output: Item[]; usage: TokenUsage; costUsd: number; incomplete: string | null }

export interface AzureConnection { baseUrl: string; apiKey: string; auth: "key" | "entra"; options: ProviderOptions }

/** Turn whatever the portal shows into the v1 base URL: `https://host/openai/v1`. */
export function normalizeEndpoint(raw: string): { baseUrl: string; deployment?: string } {
  const u = raw.trim().split(/[?#]/)[0]!.replace(/\/+$/, "");
  if (!u) return { baseUrl: "" };
  const legacy = /^(https?:\/\/[^/]+)\/openai\/deployments\/([^/]+)/.exec(u);
  if (legacy) return { baseUrl: `${legacy[1]}/openai/v1`, deployment: legacy[2] };
  const origin = /^(https?:\/\/[^/]+)/.exec(u)?.[1] ?? u;
  return { baseUrl: `${origin}/openai/v1` };
}

export function connection(reg: Registry): AzureConnection | null {
  const saved = reg.setting<{ base_url: string; key_enc: string; options: ProviderOptions } | null>("provider.azure", null);
  const baseUrl = normalizeEndpoint(saved?.base_url || config.azure.baseUrl).baseUrl;
  const options = saved?.options ?? {};
  const auth = options.auth ?? (config.azure.useEntra ? "entra" : "key");
  const apiKey = saved?.key_enc ? decrypt(saved.key_enc) : config.azure.apiKey;
  if (!baseUrl || (auth === "key" && !apiKey)) return null;
  return { baseUrl, apiKey, auth, options };
}

export function deployments(reg: Registry): string[] {
  const list = connection(reg)?.options.deployments ?? [];
  return [...new Set([config.defaultModel, ...list].filter(Boolean))];
}

let entra: { token: string; expires: number } | null = null;
async function entraToken(): Promise<string> {
  if (entra && entra.expires > Date.now() + 60_000) return entra.token;
  const res = await run(["az", "account", "get-access-token", "--resource", "https://cognitiveservices.azure.com", "-o", "json"], { cwd: process.cwd(), env: process.env, timeoutMs: 30_000 });
  if (res.code !== 0) throw new UserError("Microsoft Entra sign-in failed. Run `az login` on this computer, or use an API key.");
  const out = JSON.parse(res.output) as { accessToken: string; expiresOn?: string };
  entra = { token: out.accessToken, expires: out.expiresOn ? Date.parse(out.expiresOn) : Date.now() + 50 * 60_000 };
  return entra.token;
}

const dropped = new Map<string, Set<string>>();

function body(req: LlmRequest, drop: Set<string>): Item {
  const b: Item = {
    model: req.model, instructions: req.instructions, input: req.input, stream: true, store: false,
    max_output_tokens: req.maxOutputTokens ?? 32_000, include: ["reasoning.encrypted_content"],
  };
  if (req.tools?.length) {
    b.tools = req.tools;
    b.tool_choice = req.toolChoice ?? "auto";
    b.parallel_tool_calls = true;
  }
  const effort = req.effort && req.effort !== "default" ? req.effort : config.defaultEffort;
  if (effort !== "none") b.reasoning = { effort, summary: "auto" };
  else b.reasoning = { effort: "none" };
  for (const key of drop) {
    if (key === "reasoning.summary") delete b.reasoning?.summary;
    else delete b[key];
  }
  return b;
}

/** If a 400 names one parameter the deployment does not support, return it so the call can be retried without it. */
function rejectedParam(message: string, b: Item): string | null {
  const m = message.toLowerCase();
  if (!/unsupported|not supported|does not support|unrecognized|unknown parameter|invalid value/.test(m)) return null;
  if (m.includes("summary") && b.reasoning?.summary) return "reasoning.summary";
  for (const key of ["reasoning", "include", "parallel_tool_calls", "max_output_tokens", "tool_choice"]) if (m.includes(key) && key in b) return key;
  return null;
}

async function headers(c: AzureConnection): Promise<Record<string, string>> {
  return c.auth === "entra" ? { Authorization: `Bearer ${await entraToken()}` } : { "api-key": c.apiKey };
}

/** One model call, streamed. Throws UserError with a readable message on configuration problems. */
export async function complete(reg: Registry, req: LlmRequest, on: StreamHandlers = {}): Promise<LlmResult> {
  const c = connection(reg);
  if (!c) throw new UserError("Azure OpenAI is not connected. Open Settings → Model and add your endpoint and key.", 412);
  const drop = dropped.get(req.model) ?? new Set<string>();
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const b = body(req, drop);
    let res: Response;
    try {
      res = await fetch(`${c.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json", ...(await headers(c)) }, body: JSON.stringify(b), signal: req.signal,
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      lastError = `Could not reach Azure OpenAI: ${(e as Error).message}`;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok && res.body) return await readStream(res.body, c.options, on);
    const text = await res.text();
    const message = (() => { try { return JSON.parse(text).error?.message ?? text; } catch { return text; } })();
    lastError = `Azure OpenAI ${res.status}: ${String(message).slice(0, 500)}`;
    if (res.status === 400) {
      const bad = rejectedParam(String(message), b);
      if (bad && !drop.has(bad)) { drop.add(bad); dropped.set(req.model, drop); continue; }
      throw new UserError(lastError);
    }
    if (res.status === 401 || res.status === 403) throw new UserError(`${lastError}. Check the key or permissions in Settings → Model.`);
    if (res.status === 404) throw new UserError(`${lastError}. Is "${req.model}" the name of a deployment on this resource?`);
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * 2 ** attempt;
      await sleep(Math.min(wait, 30_000));
      continue;
    }
    throw new UserError(lastError);
  }
  throw new UserError(lastError || "Azure OpenAI did not respond");
}

async function readStream(stream: ReadableStream<Uint8Array>, options: ProviderOptions, on: StreamHandlers): Promise<LlmResult> {
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let thought = "";
  const callIds = new Map<string, string>(); // item id → call id
  let final: Item | null = null;
  let failure = "";
  const handle = (ev: Item) => {
    switch (ev.type) {
      case "response.output_text.delta": text += ev.delta; on.onText?.(ev.delta); break;
      case "response.reasoning_summary_text.delta": thought += ev.delta; on.onThinking?.(ev.delta); break;
      case "response.reasoning_summary_part.done": thought += "\n\n"; on.onThinking?.("\n\n"); break;
      case "response.output_item.added":
        if (ev.item?.type === "function_call") {
          callIds.set(ev.item.id, ev.item.call_id);
          on.onToolStart?.({ call_id: ev.item.call_id, name: ev.item.name });
        }
        break;
      case "response.function_call_arguments.delta": on.onToolArgs?.(callIds.get(ev.item_id) ?? ev.item_id, ev.delta); break;
      case "response.completed": case "response.incomplete": final = ev.response; break;
      case "response.failed": failure = ev.response?.error?.message ?? "The model call failed"; break;
      case "error": failure = ev.message ?? ev.error?.message ?? "The model call failed"; break;
    }
  };
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      try { handle(JSON.parse(data)); } catch { /* ignore keep-alives */ }
    }
  }
  if (failure) throw new UserError(`Azure OpenAI: ${failure}`);
  if (!final) throw new UserError("Azure OpenAI closed the stream before the response was complete");
  const resp = final as Item;
  const output: Item[] = resp.output ?? [];
  const calls = output.filter((o) => o.type === "function_call").map((o) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments ?? "{}" }));
  if (!text) text = output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c: Item) => c.text ?? "").join("");
  const u = resp.usage ?? {};
  const usage: TokenUsage = {
    input: u.input_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0,
    output: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
  return {
    text, thought: thought.trim(), calls, usage, costUsd: priceUsage(usage, options),
    // replay everything except plain message items without content; reasoning items carry encrypted content
    output: output.map(({ status: _s, ...item }) => item),
    incomplete: resp.status === "incomplete" ? resp.incomplete_details?.reason ?? "incomplete" : null,
  };
}
