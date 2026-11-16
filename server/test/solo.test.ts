/** The solo path end to end through the HTTP API with a scripted model: one transcript per conversation, steering, limits, stops and restarts. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasOut, MessageOut, RunDetail, WorkspaceOut } from "@octopus/shared";
import { config } from "../src/config";
import { openProject } from "../src/db/project";
import { openRegistry, type Registry } from "../src/db/registry";
import { Conversation } from "../src/engine/conversation";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { project } from "../src/workspace/projects";
import { fakeModel, outputs, type FakeModel, type Script } from "./fakeModel";

/** A request as the scripted model received it. */
interface Request { instructions: string; input: any[] } // eslint-disable-line @typescript-eslint/no-explicit-any

let app: FastifyInstance;
let reg: Registry;
let model: FakeModel;
let script: Script = () => ({ text: "ok" });
let ws: WorkspaceOut;
let companyId = "";
let dir = "";

const call = async <T>(method: string, url: string, payload?: unknown): Promise<T> => {
  const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { host: "127.0.0.1" } });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
};
const W = () => `/api/v1/w/${ws.id}`;
const requests = () => model.requests as unknown as Request[];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const TERMINAL = ["completed", "awaiting_user", "incomplete", "failed", "cancelled"];

async function until(runId: string, statuses: string[], ms = 60_000): Promise<RunDetail> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call<RunDetail>("GET", `${W()}/runs/${runId}`);
    if (statuses.includes(r.status)) return r;
    if (Date.now() > end) throw new Error(`run stayed ${r.status}: ${r.halt_reason}`);
    await sleep(20);
  }
}

/** Waits until the model has received `count` requests in all, then until the run is no longer working. */
async function turnDone(runId: string, count: number, ms = 60_000): Promise<RunDetail> {
  const end = Date.now() + ms;
  while (requests().length < count) {
    if (Date.now() > end) throw new Error(`the model received ${requests().length} requests, not ${count}`);
    await sleep(20);
  }
  return until(runId, TERMINAL, ms);
}

const start = async (goal: string) => (await call<RunDetail>("POST", `${W()}/runs`, { company_id: companyId, goal })).id;
const send = (runId: string, content: string) => call("POST", `${W()}/runs/${runId}/continue`, { content });
/** The live conversation of the company's run, reached the way the server reaches it, for steering it from a model reply. */
function liveConversation(): Conversation {
  const p = project(reg, ws.id);
  return Conversation.get(p, reg, p.db.runs.find("company_id = ?", [companyId], "created_at").at(-1)!.id);
}
/** A request's input starts with the whole of an earlier request's input, item for item. */
const startsWith = (later: Request, earlier: Request) => JSON.stringify(later.input.slice(0, earlier.input.length)) === JSON.stringify(earlier.input);

beforeAll(async () => {
  model = await fakeModel((b) => script(b));
  reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  app = await buildServer(reg);
});
afterAll(async () => { await app.close(); await model.close(); });

beforeEach(async () => {
  dir = path.join(process.env.TEST_BASE_DIR!, `s${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "index.html"), "<h1>Acme</h1>\n");
  ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
  reg.setSetting("approval_mode", "auto");
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "solo", name: "Octopus" });
  companyId = team.company.id;
});

test("a one-file change makes as many model calls as tool steps plus one", async () => {
  const before = requests().length;
  script = (b) => {
    const n = outputs(b).length;
    if (n === 0) return { calls: [{ name: "read_file", args: { path: "index.html" } }] };
    if (n === 1) return { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "Acme", new_string: "Globex" } }] };
    return { text: "Changed the heading to Globex in index.html." };
  };
  const id = await start("Rename the heading to Globex");
  const done = await turnDone(id, before + 3);
  expect(done.status).toBe("completed");
  const turn = requests().slice(before);
  const toolSteps = outputs(turn.at(-1)!).length;
  expect(turn).toHaveLength(toolSteps + 1);
  expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("Globex");
});

test("the second message's first request starts with the first message's whole transcript", async () => {
  const before = requests().length;
  let phase = 1;
  script = (b) => {
    if (phase === 2) return { text: "Second answer." };
    return outputs(b).length === 0 ? { calls: [{ name: "read_file", args: { path: "index.html" } }] } : { text: "First answer." };
  };
  const id = await start("Read the page");
  await turnDone(id, before + 2);
  phase = 2;
  await send(id, "Now the second message");
  const done = await turnDone(id, before + 3);
  expect(done.status).toBe("completed");
  const last = requests()[before + 1]!;
  const next = requests()[before + 2]!;
  expect(startsWith(next, last)).toBe(true);
  expect(next.input.length).toBeGreaterThan(last.input.length);
  expect(JSON.stringify(next.input.slice(last.input.length))).toContain("First answer.");
});

test("a message sent mid-turn arrives before the next model step", async () => {
  const before = requests().length;
  let sent = false;
  script = () => {
    if (sent) return { text: "Checked the header and the footer." };
    sent = true;
    liveConversation().submit("Also check the footer.", [], null);
    return { calls: [{ name: "read_file", args: { path: "index.html" } }] };
  };
  const id = await start("Check the page");
  const done = await turnDone(id, before + 2);
  expect(done.status).toBe("completed");
  expect(JSON.stringify(requests()[before + 1]!.input.at(-1))).toContain("Also check the footer.");
});

test("step 400 pauses the run as awaiting_user with the pause message, and a reply continues it", async () => {
  const before = requests().length;
  // The fake model reports each request's whole size as input, so a 400-step turn would reach the token budget first.
  // This test is about the step limit, so the budget is lifted for it.
  const savedBudget = config.soloTurnTokens;
  config.soloTurnTokens = Infinity;
  try {
    script = () => ({ calls: [{ name: "read_file", args: { path: "index.html" } }] });
    const id = await start("Keep reading the page");
    const paused = await until(id, ["awaiting_user", "completed", "failed"], 120_000);
    expect(requests().length - before).toBe(config.soloStepLimit);
    expect(paused.status).toBe("awaiting_user");
    expect(paused.halt_reason).toBe("Paused: reply to continue");
    const messages = await call<MessageOut[]>("GET", `${W()}/runs/${id}/messages`);
    expect(messages.at(-1)!.type).toBe("final_report");
    expect(messages.at(-1)!.content).toContain(`at the ${config.soloStepLimit}-step limit`);
    script = () => ({ text: "Done reading." });
    await send(id, "Carry on.");
    const done = await turnDone(id, before + config.soloStepLimit + 1, 120_000);
    expect(done.status).toBe("completed");
  } finally {
    config.soloTurnTokens = savedBudget;
  }
}, 180_000);

test("a stop keeps the session, and the next message continues it", async () => {
  const before = requests().length;
  let halted = false;
  script = () => {
    if (halted) return { text: "Carried on." };
    if (requests().length - before === 2) {
      halted = true;
      liveConversation().control("stop");
    }
    return { calls: [{ name: "read_file", args: { path: "index.html" } }] };
  };
  const id = await start("Read the page again and again");
  const stopped = await until(id, ["cancelled", "completed", "failed"]);
  expect(stopped.status).toBe("cancelled");
  // The request the stop interrupted holds the finished step before it, and that is the transcript kept.
  const kept = requests()[before + 1]!;
  await send(id, "Carry on.");
  const done = await turnDone(id, before + 3);
  expect(done.status).toBe("completed");
  expect(startsWith(requests()[before + 2]!, kept)).toBe(true);
});

test("a restart reloads the stored transcript", async () => {
  const before = requests().length;
  script = (b) => (outputs(b).length === 0 ? { calls: [{ name: "read_file", args: { path: "index.html" } }] } : { text: "Read it." });
  const id = await start("Read the page");
  await turnDone(id, before + 2);
  // A new process loads the run from the database: a fresh handle on the same project, as the conversation tests do.
  const restarted = Conversation.get({ ...project(reg, ws.id), db: openProject(dir) }, reg, id);
  script = () => ({ text: "Second reply." });
  restarted.submit("Second message", [], null);
  const done = await turnDone(id, before + 3);
  expect(done.status).toBe("completed");
  expect(startsWith(requests()[before + 2]!, requests()[before + 1]!)).toBe(true);
});

test("the turn budget counts cached input at a tenth of its weight", async () => {
  const before = requests().length;
  const saved = config.soloTurnTokens;
  config.soloTurnTokens = 1_000;
  try {
    // Each reply reports 5,000 input tokens, 4,900 of them cached, and 50 output tokens: 640 weighted per step
    // (100 uncached, 490 cached at a tenth, 50 output). Two steps reach 1,280, so the third never starts.
    script = () => ({ usage: 5_000, cached: 4_900, calls: [{ name: "read_file", args: { path: "index.html" } }] });
    const id = await start("Read the page");
    const paused = await until(id, ["awaiting_user", "completed", "failed"]);
    expect(requests().length - before).toBe(2);
    expect(paused.status).toBe("awaiting_user");
    const messages = await call<MessageOut[]>("GET", `${W()}/runs/${id}/messages`);
    expect(messages.at(-1)!.content).toContain("at the token budget for this turn");
  } finally {
    config.soloTurnTokens = saved;
  }
});

test("a turn that spends its token budget pauses with the budget message", async () => {
  const before = requests().length;
  const saved = config.soloTurnTokens;
  config.soloTurnTokens = 1_000;
  try {
    script = () => ({ usage: 5_000, calls: [{ name: "read_file", args: { path: "index.html" } }] });
    const id = await start("Read the page");
    const paused = await until(id, ["awaiting_user", "completed", "failed"]);
    expect(requests().length - before).toBe(1);
    expect(paused.status).toBe("awaiting_user");
    const messages = await call<MessageOut[]>("GET", `${W()}/runs/${id}/messages`);
    expect(messages.at(-1)!.content).toContain("at the token budget for this turn");
  } finally {
    config.soloTurnTokens = saved;
  }
});

test("each turn that ends with a reply is added to the run's report, under the request that began it", async () => {
  const before = requests().length;
  script = () => ({ text: "The page says Acme." });
  const id = await start("What does the page say?");
  await turnDone(id, before + 1);
  expect((await call<RunDetail>("GET", `${W()}/runs/${id}`)).report_md).toBe("## What does the page say?\n\nThe page says Acme.");
  script = () => ({ text: "It is a heading." });
  await send(id, "What kind of element is it?");
  await turnDone(id, before + 2);
  expect((await call<RunDetail>("GET", `${W()}/runs/${id}`)).report_md).toBe(
    "## What does the page say?\n\nThe page says Acme.\n\n---\n\n## What kind of element is it?\n\nIt is a heading.",
  );
});

test("each item is in the session file as it completes, so a step's call is saved before its tool finishes", async () => {
  const before = requests().length;
  script = (b) => (outputs(b).length === 0
    ? { calls: [{ name: "shell", args: { command: "node -e \"setTimeout(() => console.log('slept'), 1500)\"" } }] }
    : { text: "The command finished." });
  const id = await start("Run a short command");
  const file = path.join(project(reg, ws.id).root, ".octopus", "sessions", `${id}.jsonl`);
  // While the command sleeps, the file holds the call and not yet its output. Old code wrote the two together, after the output.
  const callInFlight = () => {
    if (!existsSync(file)) return false;
    const text = readFileSync(file, "utf8");
    return text.includes('"type":"function_call"') && !text.includes('"type":"function_call_output"');
  };
  expect(await waitFor(callInFlight, 10_000)).toBe(true);
  const done = await turnDone(id, before + 2);
  expect(done.status).toBe("completed");
});

test("the skill catalog is sent once, in the first request, and later requests do not repeat it", async () => {
  const before = requests().length;
  script = (b) => (outputs(b).length === 0 ? { calls: [{ name: "read_file", args: { path: "index.html" } }] } : { text: "Read it." });
  const id = await start("Read the page");
  await turnDone(id, before + 2);
  script = () => ({ text: "Second reply." });
  await send(id, "Second message");
  await turnDone(id, before + 3);
  const catalogs = (r: Request) => r.input.filter((item) => typeof item.content === "string" && item.content.startsWith("<skills>")).length;
  expect([0, 1, 2].map((i) => catalogs(requests()[before + i]!))).toEqual([1, 1, 1]);
  expect(requests()[before]!.input[0].content).toMatch(/^<skills>\n/);
});

test("a custom skill from Settings is listed in the catalog, with its name and description", async () => {
  reg.skills.upsert({ name: "house-style", deleted: false, updated_at: "", data: { name: "house-style", description: "Our copy rules for every page.", body: "Use sentence case.", roles: [], phases: [] } });
  try {
    const before = requests().length;
    script = () => ({ text: "Noted." });
    const id = await start("Write the page copy");
    await turnDone(id, before + 1);
    const catalog = requests()[before]!.input.find((item) => typeof item.content === "string" && item.content.startsWith("<skills>"));
    expect(catalog.content).toContain("- `house-style`: Our copy rules for every page.");
  } finally {
    reg.skills.remove("house-style");
  }
});

test("the project rules reach the first request, and an edit adds one new message after the earlier ones", async () => {
  writeFileSync(path.join(dir, "AGENTS.md"), "Use pnpm for every package command.");
  const before = requests().length;
  script = () => ({ text: "Noted." });
  const id = await start("Add a dev script");
  await turnDone(id, before + 1);
  const rulesIn = (r: Request) => r.input.filter((item) => typeof item.content === "string" && item.content.startsWith("<project-rules>"));
  expect(rulesIn(requests()[before]!)).toHaveLength(1);
  expect(rulesIn(requests()[before]!)[0]!.content).toContain("Use pnpm for every package command.");
  writeFileSync(path.join(dir, "AGENTS.md"), "Use npm for every package command.");
  script = () => ({ text: "Noted again." });
  await send(id, "Now the second message");
  const done = await turnDone(id, before + 2);
  expect(done.status).toBe("completed");
  const later = requests()[before + 1]!;
  expect(rulesIn(later)).toHaveLength(2);
  expect(rulesIn(later)[0]!.content).toContain("Use pnpm for every package command.");
  expect(rulesIn(later)[1]!.content).toContain("Use npm for every package command.");
  expect(startsWith(later, requests()[before]!)).toBe(true);
});

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(10);
  }
  return false;
}
