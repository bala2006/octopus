import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ProviderOptions } from "@octopus/shared";
import { agentLoop, CHECKPOINT_REQUEST, keptFrom, tokensOf } from "../src/engine/agent";
import { openRegistry, type Registry } from "../src/db/registry";
import { encrypt } from "../src/lib/secrets";
import type { Item } from "../src/llm/azure";
import { ProjectFs, WORK_DIR } from "../src/safety/paths";
import { defineTool, type Shown, type Tool, type ToolContext } from "../src/tools/types";
import { fakeModel, type Script } from "./fakeModel";

/** A transcript shaped like the model's: steps of reasoning plus parallel calls, then their outputs, and a user note. */
function transcript(): Item[] {
  const items: Item[] = [{ role: "user", content: "# T1: brief" }];
  for (let s = 0; s < 12; s++) {
    items.push({ type: "reasoning", id: `r${s}`, encrypted_content: "x".repeat(40 + s * 7) });
    const calls = 1 + (s % 3);
    for (let c = 0; c < calls; c++) items.push({ type: "function_call", call_id: `c${s}.${c}`, name: "read_file", arguments: "{}" });
    for (let c = 0; c < calls; c++) items.push({ type: "function_call_output", call_id: `c${s}.${c}`, output: "y".repeat(90 + c * 31) });
    if (s % 4 === 3) items.push({ role: "user", content: "a teammate changed a file" });
  }
  return items;
}

test("whatever the tail size, the kept part starts on a whole step", () => {
  const items = transcript();
  let cuts = 0;
  for (let keepTail = 50; keepTail < JSON.stringify(items).length; keepTail += 37) {
    const start = keptFrom(items, 1, keepTail);
    if (start === null) continue;
    cuts++;
    const kept = items.slice(start);
    const calls = new Set(kept.filter((i) => i.type === "function_call").map((i) => i.call_id));
    for (const out of kept.filter((i) => i.type === "function_call_output")) expect(calls.has(out.call_id)).toBe(true);
    const first = kept[0]!;
    expect(first.type === "reasoning" || first.role === "user").toBe(true);
  }
  expect(cuts).toBeGreaterThan(10);
});

test("the head is never summarized away", () => {
  const items = [{ role: "user", content: "held note" }, { role: "user", content: "# T1: brief" }, ...transcript().slice(1)];
  const start = keptFrom(items, 2, 200);
  expect(start).toBeGreaterThan(2);
});

/** A registry whose Azure connection points at the fake model, with the given provider options. */
function registryFor(url: string, options: ProviderOptions = {}): Registry {
  const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "agent-")), "registry.db"));
  reg.setSetting("provider.azure", { base_url: url, key_enc: encrypt("test-key"), options: { auth: "key", ...options }, updated_at: "" });
  return reg;
}

const noEvents = {
  text() {}, thinking() {}, thought() {}, toolStart() {}, toolArgs() {}, toolCall() {}, toolResult() {}, usage() {},
  async beforeCall() {},
};

/** Drive the real loop against the scripted model, and return what it sent and what it ended with. */
async function runLoop(script: Script, tools: Tool[], options: ProviderOptions = {}, rounds = 12, loop: { requireStop?: boolean; stopTools?: string[] } = {}) {
  const model = await fakeModel(script);
  const reg = registryFor(model.url, options);
  const root = mkdtempSync(path.join(tmpdir(), "agent-fs-"));
  const shown: Shown = new Map();
  const ctx = { agent: {}, task: null, runId: "run", signal: new AbortController().signal, shown, seen: new Map(), answering: null, fs: new ProjectFs(root) } as unknown as ToolContext;
  const input: Item[] = [{ role: "user", content: "# T1: brief" }];
  try {
    const result = await agentLoop({ reg, model: "test-model", effort: undefined, instructions: "test", input, tools, ctx, events: noEvents, maxRounds: rounds, requireStop: loop.requireStop ?? false, stopTools: loop.stopTools ?? [], keepHead: 1 });
    const requests = model.requests as { input: Item[] }[];
    return { result, input, shown, requests, root };
  } finally {
    await model.close();
  }
}

const isCheckpointRequest = (r: { input: Item[] }) => String(r.input.at(-1)?.content ?? "").startsWith(CHECKPOINT_REQUEST.slice(0, 40));

/** A request's stored items: the request without its ephemeral screenshot message, which the loop never stores. */
function storedPart(sent: Item[]): Item[] {
  const last = sent.at(-1);
  return last && JSON.stringify(last).includes('"input_image"') ? sent.slice(0, -1) : sent;
}

/** A tool that reads one file per call and returns `outputChars` characters of it. */
function touchTool(outputChars: number): Tool {
  return defineTool({
    name: "touch", description: "Read a file.", args: z.object({ file: z.string() }),
    async run(ctx, a) {
      ctx.shown.set(a.file, { hash: `hash-${a.file}`, ranges: [[1, 1]] });
      return { text: `touched ${a.file}\n${"x".repeat(outputChars)}` };
    },
  });
}

/** Read `rounds` files, one per step, then finish with text. */
function touchScript(rounds: number): Script {
  let calls = 0;
  return (b) => {
    const last = b.input.at(-1);
    if (last?.role === "user" && String(last.content).startsWith("Write a checkpoint")) return { text: "## Goal\nRead the first files." };
    if (++calls <= rounds) return { calls: [{ name: "touch", args: { file: `f${calls}.ts` } }] };
    return { text: "done" };
  };
}

/** The files whose full output is in a transcript: a spilled or pruned output no longer holds its file. */
const filesIn = (sent: Item[]) => [...new Set(sent
  .filter((i) => i.type === "function_call_output" && !String(i.output).includes("characters not shown"))
  .map((i) => /^touched (\S+)/.exec(String(i.output))?.[1])
  .filter((f): f is string => !!f))].sort();

// Window 40,000 compacts at 8,000 tokens and keeps about 1,280 tokens of recent steps.
const SMALL_WINDOW: ProviderOptions = { context_window: 40_000 };

test("after summarizing, the file-read ledger keeps the files still in the transcript and drops the rest", async () => {
  const { shown, requests } = await runLoop(touchScript(14), [touchTool(3_000)], SMALL_WINDOW, 18);
  const sent = requests.at(-1)!.input;
  expect(sent.some((i) => String(i.content ?? "").includes("<checkpoint>"))).toBe(true);
  // A file read before the checkpoint and still in the kept tail must stay in the ledger, or the next read of it is sent again for nothing.
  expect([...shown.keys()].sort()).toEqual(filesIn(sent));
});

test("summarizing never edits the kept part of the transcript: the brief and the tail come through unchanged", async () => {
  const { input } = await runLoop(touchScript(14), [touchTool(3_000)], SMALL_WINDOW, 18);
  expect(input[0]).toEqual({ role: "user", content: "# T1: brief" });
  const lastOutput = [...input].reverse().find((i) => i.type === "function_call_output");
  expect(lastOutput?.output).toContain("touched f14.ts");
});

test("a tool result above 40,000 characters is saved in full, and the model sees its head, its tail and the path", async () => {
  const full = `HEAD-MARK${"m".repeat(100_000)}TAIL-MARK`;
  const shout = defineTool({ name: "shout", description: "Print a lot.", args: z.object({}), async run() { return { text: full }; } });
  let calls = 0;
  const { requests, root } = await runLoop(() => (++calls === 1 ? { calls: [{ name: "shout", args: {} }] } : { text: "done" }), [shout]);
  const output = String(requests[1]!.input.find((i) => i.type === "function_call_output")!.output);
  expect(output).toContain("HEAD-MARK");
  expect(output).toContain("TAIL-MARK");
  expect(output.length).toBeLessThan(42_000);
  const rel = /\.octopus\/work\/spill\/[\w-]+\.txt/.exec(output)?.[0];
  expect(rel?.startsWith(`${WORK_DIR}/spill/`)).toBe(true);
  expect(readFileSync(path.join(root, rel!), "utf8")).toBe(full);
});

test("six 60,903-character screenshots trigger no checkpoint, because an image counts as a fixed token cost", async () => {
  const image = `data:image/jpeg;base64,${"A".repeat(60_903 - "data:image/jpeg;base64,".length)}`;
  const shot = defineTool({ name: "shot", description: "Take a screenshot.", args: z.object({}), async run() { return { text: "shot", image }; } });
  let calls = 0;
  const { requests } = await runLoop(() => (++calls <= 6 ? { calls: [{ name: "shot", args: {} }] } : { text: "done" }), [shot]);
  expect(requests.some(isCheckpointRequest)).toBe(false);
});

test("six screenshots make seven requests: six carry one image each, and no stored item ever changes", async () => {
  const image = `data:image/jpeg;base64,${"A".repeat(60_903 - "data:image/jpeg;base64,".length)}`;
  const shot = defineTool({ name: "shot", description: "Take a screenshot.", args: z.object({}), async run() { return { text: "shot", image }; } });
  let calls = 0;
  const { requests, input } = await runLoop(() => (++calls <= 6 ? { calls: [{ name: "shot", args: {} }] } : { text: "done" }), [shot]);
  const imageParts = requests.map((r) => JSON.stringify(r.input).split('"input_image"').length - 1);
  expect(imageParts).toEqual([0, 1, 1, 1, 1, 1, 1]);
  expect(input.filter((i) => String(i.content).startsWith("Screenshot taken: shot.")).length).toBe(6);
  expect(JSON.stringify(input).includes('"input_image"')).toBe(false);
  const stored = requests.map((r) => storedPart(r.input));
  for (let i = 1; i < stored.length; i++) {
    expect(JSON.stringify(stored[i]!.slice(0, stored[i - 1]!.length))).toBe(JSON.stringify(stored[i - 1]));
  }
});

test("the compaction trigger reads the input tokens the last response reported", async () => {
  // Five 3,000-character reads are about 2,000 tokens. Only a report of 9,000 tokens crosses the 8,000-token trigger.
  const reported = (spike: number): Script => {
    const script = touchScript(8);
    let call = 0;
    return (b) => {
      const reply = script(b);
      return isCheckpointRequestBody(b) || !reply.calls ? reply : { ...reply, usage: ++call === 6 ? spike : tokensOf(b.input) };
    };
  };
  const spiked = await runLoop(reported(9_000), [touchTool(3_000)], SMALL_WINDOW, 12);
  expect(spiked.requests.some(isCheckpointRequest)).toBe(true);
  const quiet = await runLoop(reported(100), [touchTool(3_000)], SMALL_WINDOW, 12);
  expect(quiet.requests.some(isCheckpointRequest)).toBe(false);
});

function isCheckpointRequestBody(b: { input: Item[] }) {
  return isCheckpointRequest({ input: b.input });
}

test("each request's stored items are a prefix of the stored transcript the loop ends with", async () => {
  const { requests, input } = await runLoop(touchScript(4), [touchTool(3_000)]);
  expect(requests.length).toBeGreaterThan(3);
  for (const r of requests) {
    const stored = JSON.stringify(storedPart(r.input));
    expect(stored).toBe(JSON.stringify(input.slice(0, storedPart(r.input).length)));
  }
});

test("five failed calls in one step do not end the turn, and the model sees every error", async () => {
  const fail = defineTool({ name: "fail", description: "Always fails.", args: z.object({ n: z.number() }), async run(_ctx, a) { return { text: `no such file ${a.n}`, ok: false }; } });
  const { result, requests } = await runLoop((b) => (b.input.length === 1
    ? { calls: [1, 2, 3, 4, 5].map((n) => ({ name: "fail", args: { n } })) }
    : { text: "done" }), [fail]);
  expect(result.stop).toBeNull();
  expect(result.text).toBe("done");
  const outputs = requests[1]!.input.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
  expect(outputs).toHaveLength(5);
  expect(outputs.every((o, i) => o === `no such file ${i + 1}`)).toBe(true);
});

test("a turn that must end names only the ending tools in its own toolbox, in its nudge and its wrap-up", async () => {
  const touch = touchTool(10);
  const nudge = await runLoop(() => ({ text: "I am thinking about it." }), [touch], {}, 12, { requireStop: true, stopTools: ["submit_review"] });
  const nudged = String(nudge.requests[1]!.input.at(-1)!.content);
  expect(nudged).toContain("(submit_review)");
  expect(nudged).not.toContain("complete_task");
  // With six rounds the wrap-up is due at round two (maxRounds - 5 + 1), before the second call.
  const wrap = await runLoop((b) => (b.input.some((i: Item) => String(i.content ?? "").includes("almost out of steps")) ? { text: "done" } : { calls: [{ name: "touch", args: { file: "a.ts" } }] }), [touch], {}, 6, { requireStop: true, stopTools: ["block_task"] });
  const wrapUp = wrap.requests.map((r) => String(r.input.at(-1)?.content ?? "")).find((c) => c.includes("almost out of steps"))!;
  expect(wrapUp).toContain("(block_task)");
  expect(wrapUp).not.toContain("submit_review");
});
test("a spilled output drops its file from the ledger, since the transcript holds only its head and tail", async () => {
  const { shown, requests } = await runLoop(touchScript(2), [touchTool(45_000)]);
  expect(shown.size).toBe(0);
  expect(String(requests.at(-1)!.input.find((i) => i.type === "function_call_output")!.output)).toContain("characters not shown");
});
