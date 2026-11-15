import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentLoop, contextLimits, keptFrom } from "../src/engine/agent";
import { openRegistry } from "../src/db/registry";
import { encrypt } from "../src/lib/secrets";
import type { Item } from "../src/llm/azure";
import { defineTool, type Shown, type ToolContext } from "../src/tools/types";
import { fakeModel } from "./fakeModel";
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

/**
 * Drive the real loop against the scripted model: one file read per round, each output large, so the transcript
 * crosses the compaction or truncation limit. Returns the ledger the loop ends with and the transcript the model
 * received last.
 */
async function ledgerRun(limits: { summarizeAt: number; keepTail: number; truncateAt: number }, outputChars: number, rounds: number) {
  let calls = 0;
  const model = await fakeModel((b) => {
    const last = b.input.at(-1);
    if (last?.role === "user" && String(last.content).startsWith("Write a checkpoint")) return { text: "## Done\nRead the first files." };
    if (++calls <= rounds) return { calls: [{ name: "touch", args: { file: `f${calls}.ts` } }] };
    return { text: "done" };
  });
  const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "ledger-")), "registry.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  const touch = defineTool({
    name: "touch", description: "Read a file.", args: z.object({ file: z.string() }),
    async run(ctx, a) {
      ctx.shown.set(a.file, { hash: `hash-${a.file}`, ranges: [[1, 1]] });
      return { text: `touched ${a.file}\n${"x".repeat(outputChars)}` };
    },
  });
  const shown: Shown = new Map();
  const ctx = { agent: {}, task: null, runId: "run", signal: new AbortController().signal, shown, seen: new Map(), answering: null } as unknown as ToolContext;
  const events = {
    text() {}, thinking() {}, thought() {}, toolStart() {}, toolArgs() {}, toolCall() {}, toolResult() {}, usage() {},
    async beforeCall() {},
  };
  const input: Item[] = [{ role: "user", content: "# T1: brief" }];
  const saved = { ...contextLimits };
  Object.assign(contextLimits, limits);
  try {
    await agentLoop({ reg, model: "test-model", effort: undefined, instructions: "test", input, tools: [touch], ctx, events, maxRounds: rounds + 3, requireStop: false, keepHead: 1 });
  } finally {
    Object.assign(contextLimits, saved);
  }
  const sent = model.requests.at(-1).input as Item[];
  await model.close();
  return { shown, sent, input };
}

/** The files whose full output is in a transcript: a shortened output no longer holds its file. */
const filesIn = (sent: Item[]) => [...new Set(sent
  .filter((i) => i.type === "function_call_output" && !String(i.output).includes("shortened to save context"))
  .map((i) => /^touched (\S+)/.exec(String(i.output))?.[1])
  .filter((f): f is string => !!f))].sort();

test("after summarizing, the file-read ledger keeps the files still in the transcript and drops the rest", async () => {
  const { shown, sent } = await ledgerRun({ summarizeAt: 3_000, keepTail: 1_200, truncateAt: 10_000_000 }, 600, 8);
  expect(sent.some((i) => String(i.content ?? "").includes("<checkpoint>"))).toBe(true);
  // A file read before the checkpoint and still in the kept tail must stay in the ledger, or the next read of it is sent again for nothing.
  expect([...shown.keys()].sort()).toEqual(filesIn(sent));
});

test("when older tool outputs are shortened, the ledger drops exactly the files whose content was shortened", async () => {
  const { shown, sent } = await ledgerRun({ summarizeAt: 10_000_000, keepTail: 1_000, truncateAt: 7_100 }, 1_800, 4); // a budget that shortens the three oldest outputs and keeps the newest whole
  expect(sent.some((i) => i.type === "function_call_output" && String(i.output).includes("shortened to save context"))).toBe(true);
  expect(filesIn(sent).length).toBeGreaterThan(0); // some full outputs must survive, or the check proves nothing
  expect([...shown.keys()].sort()).toEqual(filesIn(sent));
});

test("summarizing never edits the kept part of the transcript: the brief and the tail come through unchanged", async () => {
  const { input } = await ledgerRun({ summarizeAt: 3_000, keepTail: 1_200, truncateAt: 10_000_000 }, 600, 8);
  expect(input[0]).toEqual({ role: "user", content: "# T1: brief" });
  const lastOutput = [...input].reverse().find((i) => i.type === "function_call_output");
  expect(lastOutput?.output).toContain("touched f8.ts");
});





