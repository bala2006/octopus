import { z } from "zod";
import { budgetSpent, browserBudget } from "../src/tools/budget";
import { defineTool, type ToolContext } from "../src/tools/types";

/** A tool that records each run in `ran`, so a test can tell what actually executed. */
const tool = (name: string, ran: string[]) =>
  defineTool({ name, description: name, args: z.object({}), async run() { ran.push(name); return { text: `${name} ran` }; } });

const ctx = {} as ToolContext;

test("browser calls past the limit are refused and never run", async () => {
  const ran: string[] = [];
  const [click] = browserBudget([tool("browser_click", ran)], 2);
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await click!.run(ctx, {}, `call-${i}`));
  expect(ran).toEqual(["browser_click", "browser_click"]);
  expect(results[2]).toEqual({ text: budgetSpent(2), ok: false });
  expect(results[0]).toEqual({ text: "browser_click ran" });
});

test("the limit counts every browser tool together, and other tools are not limited", async () => {
  const ran: string[] = [];
  const [click, snapshot, read] = browserBudget([tool("browser_click", ran), tool("browser_snapshot", ran), tool("read_file", ran)], 2);
  await click!.run(ctx, {}, "a");
  await snapshot!.run(ctx, {}, "b");
  const refused = await click!.run(ctx, {}, "c");
  expect(refused.ok).toBe(false);
  for (let i = 0; i < 4; i++) await read!.run(ctx, {}, `r${i}`);
  expect(ran.filter((n) => n === "read_file")).toHaveLength(4);
  expect(ran.filter((n) => n.startsWith("browser_"))).toHaveLength(2);
});
