/**
 * A scripted stand-in for the model. Each model call takes the next reply for its kind of turn, in the order the scenario
 * lists them, so a scenario reaches a result only through the tool calls it names. Every request is counted, and a call
 * the scenario has no reply for is answered with a sentence and counted as unmatched.
 *
 * Run alone (`npm run model:scripted -- --scenario scenarios/one-file-edit.json --port 4010`) it serves the replies over
 * HTTP, so a real server and app can use it. `--log <file>` writes every request body as one JSON line.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { fakeModel, turnKind, type FakeModel, type Reply, type Script } from "../test/fakeModel";

export const TURN_KINDS = ["plan", "work", "review", "acceptance", "report", "consult", "chat"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

const ReplySchema = z.object({
  text: z.string().optional(),
  calls: z.array(z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) })).optional(),
});
export const ScenarioSchema = z.object({
  description: z.string().min(1),
  replies: z.partialRecord(z.enum(TURN_KINDS), z.array(ReplySchema)),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

const scenarioDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "scenarios");

/** Read a scenario file. A name without a folder is looked up in eval/scenarios. */
export function loadScenario(file: string): Scenario {
  const full = file.includes(path.sep) || file.includes("/") ? path.resolve(file) : path.join(scenarioDir, file);
  return ScenarioSchema.parse(JSON.parse(readFileSync(full, "utf8")));
}

/** The request is the transcript plus the engine's checkpoint question, as in conversation.ts `summarize`. */
export function isCheckpoint(body: { input: unknown[] }): boolean {
  return JSON.stringify(body.input.at(-1) ?? null).includes("Write a checkpoint of your work so far");
}

export interface ScriptStats { unmatched: number; checkpoints: number }

/** A script function that serves a scenario's replies in order, one cursor per turn kind. */
export function scriptFor(scenario: Scenario): { script: Script; stats: ScriptStats } {
  const cursor = new Map<TurnKind, number>();
  const stats: ScriptStats = { unmatched: 0, checkpoints: 0 };
  const script: Script = (body) => {
    if (isCheckpoint(body)) {
      stats.checkpoints++;
      return { text: "Checkpoint of the work so far." };
    }
    const kind = turnKind(body) as TurnKind;
    const replies = scenario.replies[kind] ?? [];
    const at = cursor.get(kind) ?? 0;
    cursor.set(kind, at + 1);
    if (at < replies.length) return replies[at] as Reply;
    stats.unmatched++;
    return { text: `The scenario has no ${kind} reply for this call.` };
  };
  return { script, stats };
}

export type ScriptedModel = FakeModel & { stats: ScriptStats };

/** Serve a scenario on `port` (0 picks a free port). `log`, when set, receives every request body as one JSON line. */
export async function startScriptedModel(scenario: Scenario, opts: { port?: number; log?: string } = {}): Promise<ScriptedModel> {
  const { script, stats } = scriptFor(scenario);
  const logged: Script = (body) => {
    const reply = script(body);
    if (opts.log) appendFileSync(opts.log, `${JSON.stringify(body)}\n`);
    return reply;
  };
  const model = await fakeModel(logged, opts.port ?? 0);
  return { ...model, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { scenario: { type: "string" }, port: { type: "string", default: "4010" }, log: { type: "string" } }, strict: true });
  if (!values.scenario) throw new Error("Pass --scenario <file>, for example scenarios/one-file-edit.json");
  const scenario = loadScenario(values.scenario);
  const model = await startScriptedModel(scenario, { port: Number(values.port), log: values.log });
  console.log(`Scripted model for "${scenario.description}" at ${model.url}`);
  const stop = () => void model.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
