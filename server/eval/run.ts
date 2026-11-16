/**
 * Runs eval tasks through the HTTP API, as test/benchmark.test.ts does: a workspace from a copy of the task's repo, a team
 * from a template, a run with the task's goal, then the grader on the finished project.
 *
 * Without `--url` it starts an in-process server whose model is the task's scripted scenario. With `--url` it drives a
 * server that is already running, and that server uses its own model.
 *
 *   npm run eval -w server -- --mode pipeline --template solo_engineer --tasks fix-pagination --repeat 1
 *   npm run eval -w server -- --mode solo --tasks fix-pagination --repeat 1
 *
 * `--mode solo` runs the company made from the `solo` template, where one main agent works alone. Without --template,
 * pipeline runs use `solo_engineer` and solo runs use `solo`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { gradeProject, listTasks, loadTask, TASKS_DIR, type Grade } from "./grade";
import { loadScenario, startScriptedModel, type ScriptedModel } from "./scriptedModel";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.join(here, "..", "eval-results");
const WORK_DIR = path.join(RESULTS_DIR, "work");
const SCENARIO_DIR = path.join(here, "scenarios");
const DONE_STATUSES = ["completed", "incomplete", "failed", "cancelled"];
const RUN_TIMEOUT_MS = 15 * 60_000;

const UsageSchema = z.object({
  llm_calls: z.number().optional(),
  input_tokens: z.number().optional(),
  cached_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_tokens: z.number().optional(),
  cost_usd: z.number().optional(),
  model_ms: z.number().optional(),
  tool_calls: z.number().optional(),
  tool_failures: z.number().optional(),
});
const RunViewSchema = z.object({
  status: z.string(),
  halt_reason: z.string().nullish(),
  state: z.object({ usage: UsageSchema.optional() }).optional(),
});
type RunView = z.infer<typeof RunViewSchema>;

export const RowSchema = z.object({
  sha: z.string(),
  at: z.string(),
  task: z.string(),
  mode: z.enum(["pipeline", "solo"]),
  template: z.string(),
  repeat: z.number().int(),
  target: z.enum(["in-process", "url"]),
  run_id: z.string(),
  run_status: z.string(),
  halt_reason: z.string(),
  graded: z.boolean(),
  pass: z.boolean().nullable(),
  checks_passed: z.number().int(),
  checks_total: z.number().int(),
  model_calls: z.number().int(),
  input_tokens: z.number(),
  cached_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  cost_usd: z.number(),
  wall_s: z.number(),
  model_s: z.number(),
  overhead_s: z.number(),
  tool_calls: z.number().int(),
  tool_failures: z.number().int(),
  /** Counted from the scripted model's requests. Null against a live server, whose API does not report checkpoints. */
  checkpoint_calls: z.number().int().nullable(),
  /** Scripted runs only: model calls the scenario had no reply for. A non-zero value means the scenario drifted. */
  unmatched_replies: z.number().int().nullable(),
  workdir: z.string(),
});
export type Row = z.infer<typeof RowSchema>;

export type EvalMode = "pipeline" | "solo";
/** The company template each mode runs when --template is not given. */
const DEFAULT_TEMPLATE: Record<EvalMode, string> = { pipeline: "solo_engineer", solo: "solo" };

export interface EvalOptions {
  mode: EvalMode;
  template?: string;
  tasks: string[];
  repeat: number;
  url?: string;
}

const currentSha = (): string => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  } catch {
    return "nogit";
  }
};

/** Start the real server in this process, with the registry in a fresh folder and the work folder as its only root. */
async function startInProcess() {
  const home = mkdtempSync(path.join(tmpdir(), "octopus-eval-home-"));
  mkdirSync(RESULTS_DIR, { recursive: true });
  process.env.OCTOPUS_HOME = home;
  process.env.WORKSPACE_ALLOWED_ROOTS = RESULTS_DIR;
  process.env.BROWSER_ENABLED = "false";
  process.env.NATIVE_DIALOGS = "false";
  process.env.AZURE_API_BASE = "";
  process.env.AZURE_API_KEY = "";
  const { openRegistry } = await import("../src/db/registry");
  const { buildServer } = await import("../src/http/server");
  const { encrypt } = await import("../src/lib/secrets");
  const reg = openRegistry(path.join(home, "registry.db"));
  const app = await buildServer(reg);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    /** Point the server's Azure connection at a scripted model. */
    useModel(url: string) {
      reg.setSetting("provider.azure", { base_url: url, key_enc: encrypt("eval-key"), options: { auth: "key" }, updated_at: new Date().toISOString() });
    },
    close: () => app.close(),
  };
}

function makeApi(baseUrl: string) {
  return async <T = unknown>(method: string, url: string, body?: unknown): Promise<T> => {
    const res = await fetch(baseUrl + url, {
      method,
      headers: { "content-type": "application/json", host: "127.0.0.1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} returned ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
}
type Api = ReturnType<typeof makeApi>;

async function waitForRun(api: Api, W: string, runId: string): Promise<RunView> {
  const end = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const run = RunViewSchema.parse(await api("GET", `${W}/runs/${runId}`));
    if (DONE_STATUSES.includes(run.status)) return run;
    if (Date.now() > end) throw new Error(`Run ${runId} is still ${run.status} after ${RUN_TIMEOUT_MS} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Target {
  api: Api;
  inProcess: Awaited<ReturnType<typeof startInProcess>> | null;
}

async function runOnce(target: Target, opts: EvalOptions, sha: string, id: string, repeat: number): Promise<Row> {
  const task = loadTask(id);
  const template = opts.template ?? DEFAULT_TEMPLATE[opts.mode];
  const workdir = path.join(WORK_DIR, `${id}-r${repeat}-${Date.now()}`);
  mkdirSync(WORK_DIR, { recursive: true });
  cpSync(path.join(TASKS_DIR, id, "repo"), workdir, { recursive: true });
  const scripted: ScriptedModel | null = target.inProcess
    ? await startScriptedModel(loadScenario(path.join(SCENARIO_DIR, `${id}.json`)))
    : null;
  try {
    if (scripted) target.inProcess!.useModel(scripted.url);
    const started = Date.now();
    const ws = await target.api<{ id: string }>("POST", "/api/v1/workspaces", { path: workdir });
    const W = `/api/v1/w/${ws.id}`;
    const team = await target.api<{ company: { id: string } }>("POST", `${W}/companies/from-template`, { template_key: template, name: "Octopus" });
    const created = await target.api<{ id: string }>("POST", `${W}/runs`, { company_id: team.company.id, goal: task.goal });
    const run = await waitForRun(target.api, W, created.id);
    const wallS = (Date.now() - started) / 1000;
    const grade: Grade = await gradeProject(id, workdir);
    const usage = run.state?.usage ?? {};
    const modelS = (usage.model_ms ?? 0) / 1000;
    return RowSchema.parse({
      sha, at: new Date().toISOString(), task: id, mode: opts.mode, template, repeat,
      target: target.inProcess ? "in-process" : "url", run_id: created.id, run_status: run.status, halt_reason: run.halt_reason ?? "",
      graded: grade.graded, pass: grade.pass, checks_passed: grade.checks.filter((c) => c.pass).length, checks_total: grade.checks.length,
      model_calls: usage.llm_calls ?? 0, input_tokens: usage.input_tokens ?? 0, cached_tokens: usage.cached_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0, reasoning_tokens: usage.reasoning_tokens ?? 0, cost_usd: usage.cost_usd ?? 0,
      wall_s: wallS, model_s: modelS, overhead_s: wallS - modelS,
      tool_calls: usage.tool_calls ?? 0, tool_failures: usage.tool_failures ?? 0,
      checkpoint_calls: scripted ? scripted.stats.checkpoints : null,
      unmatched_replies: scripted ? scripted.stats.unmatched : null,
      workdir,
    });
  } finally {
    await scripted?.close();
  }
}

/** Run the tasks and grade each run. Returns one row per run, in order. */
export async function runEval(opts: EvalOptions): Promise<Row[]> {
  const tasks = opts.tasks.length ? opts.tasks : listTasks();
  for (const id of tasks) {
    loadTask(id);
    if (!opts.url && !existsSync(path.join(SCENARIO_DIR, `${id}.json`))) {
      throw new Error(`No scripted scenario for ${id}. Run it against a live server with --url.`);
    }
  }
  const inProcess = opts.url ? null : await startInProcess();
  const api = makeApi(opts.url ?? inProcess!.url);
  const sha = currentSha();
  const previous = (await api<{ approval_mode: string }>("GET", "/api/v1/settings")).approval_mode;
  await api("PUT", "/api/v1/settings/approval-mode", { approval_mode: "auto" });
  const rows: Row[] = [];
  try {
    for (const id of tasks) {
      for (let repeat = 1; repeat <= opts.repeat; repeat++) rows.push(await runOnce({ api, inProcess }, opts, sha, id, repeat));
    }
  } finally {
    await api("PUT", "/api/v1/settings/approval-mode", { approval_mode: previous });
    await inProcess?.close();
  }
  return rows;
}

const formatRow = (r: Row) =>
  `${r.task.padEnd(16)} ${r.mode} #${r.repeat}  ${r.pass === null ? "NOT RUN" : r.pass ? "PASS" : "FAIL"}  checks ${r.checks_passed}/${r.checks_total}  ` +
  `calls ${r.model_calls}  input ${r.input_tokens}  wall ${r.wall_s.toFixed(1)}s  run ${r.run_status}`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "pipeline" },
      template: { type: "string" },
      tasks: { type: "string", default: "" },
      repeat: { type: "string", default: "1" },
      url: { type: "string" },
    },
    strict: true,
  });
  const opts: EvalOptions = {
    mode: z.enum(["pipeline", "solo"], { error: () => "Use --mode pipeline or --mode solo." }).parse(values.mode),
    template: values.template === undefined ? undefined : z.string().min(1).parse(values.template),
    tasks: values.tasks ? values.tasks.split(",").map((t) => t.trim()).filter(Boolean) : [],
    repeat: z.coerce.number().int().min(1).max(50).parse(values.repeat),
    url: values.url ? z.url().parse(values.url) : undefined,
  };
  const rows = await runEval(opts);
  const file = path.join(RESULTS_DIR, `${rows[0]?.sha ?? currentSha()}-${opts.mode}.jsonl`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  for (const row of rows) appendFileSync(file, `${JSON.stringify(row)}\n`);
  for (const row of rows) console.log(formatRow(row));
  console.log(`Wrote ${rows.length} row(s) to ${path.relative(process.cwd(), file)}`);
  process.exit(0);
}

