import { keptFrom } from "../src/engine/agent";
import type { Item } from "../src/llm/azure";

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
