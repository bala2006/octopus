/**
 * The solo path's checks-first floor, end to end through the HTTP API with a scripted model. The project checks are real
 * commands in a temporary project; the model is a script, so no network or real model is used.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasOut, MessageOut, RunDetail, WorkspaceOut } from "@octopus/shared";
import { openRegistry, type Registry } from "../src/db/registry";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { ProjectFs } from "../src/safety/paths";
import { verificationChecks } from "../src/workspace/overview";
import { project } from "../src/workspace/projects";
import { fakeModel, outputs, type FakeModel, type Reply, type Script } from "./fakeModel";

/** A request as the scripted model received it. */
interface Request { instructions: string; input: any[]; tools: { name: string }[] } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Specialist types the scripted model can tell apart by the prompt each one runs with. */
const SPECIALIST_PROMPTS: [string, string][] = [
  ["You are the reviewer on a coding team", "reviewer"],
  ["You are the security reviewer on a coding team", "security"],
  ["You are the designer on a coding team", "designer"],
  ["You answer one question for Octopus", "explorer"],
];

const BLOCK_PREFIX = "The project's checks fail after your change.";
const approve: Reply = { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks right.", findings: [] } }] };

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
/** The specialist a request runs for, or null for the main agent. */
const who = (b: Request) => SPECIALIST_PROMPTS.find(([text]) => b.instructions.includes(text))?.[1] ?? null;
/** The text of the last user message a request holds: the request's own message, or a message the floor sent. */
const lastUser = (b: Request) => String([...b.input].reverse().find((i) => i.role === "user" && typeof i.content === "string")?.content ?? "");
const start = async (goal: string) => (await call<RunDetail>("POST", `${W()}/runs`, { company_id: companyId, goal })).id;

/** Waits until the run is no longer working. */
async function settle(runId: string, ms = 120_000): Promise<RunDetail> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call<RunDetail>("GET", `${W()}/runs/${runId}`);
    if (["completed", "awaiting_user", "incomplete", "failed", "cancelled"].includes(r.status)) return r;
    if (Date.now() > end) throw new Error(`run stayed ${r.status}`);
    await sleep(25);
  }
}
/** The events of one type a run wrote to its project log. */
const events = (runId: string, type: string) => project(reg, ws.id).db.events.find("run_id = ? AND type = ?", [runId, type], "seq").map((e) => e.data as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
const messagesOf = (runId: string) => call<MessageOut[]>("GET", `${W()}/runs/${runId}/messages`);

/** Writes a project with the given package.json scripts at the root and in each folder. */
function writeProject(root: Record<string, string>, folders: Record<string, Record<string, string>> = {}) {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app", private: true, scripts: root }));
  for (const [folder, scripts] of Object.entries(folders)) {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, "package.json"), JSON.stringify({ name: folder, private: true, scripts }));
  }
}
/** A file of `count` numbered lines, so a write changes about that many lines. */
const lines = (count: number) => Array.from({ length: count }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
/** A check that fails until the project has a fixed.flag file, so a fix is a new file rather than an overwrite. */
const CHECK = "import { existsSync } from 'node:fs';\nif (existsSync('fixed.flag')) {\n  console.log('checks passed');\n} else {\n  console.log('expected 2 got 1');\n  process.exit(1);\n}\n";

beforeAll(async () => {
  model = await fakeModel((b) => script(b));
  reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  app = await buildServer(reg);
});
afterAll(async () => { await app.close(); await model.close(); });

beforeEach(async () => {
  dir = path.join(process.env.TEST_BASE_DIR!, `v${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, "index.html"), "<h1>Acme</h1>\n");
  ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
  reg.setSetting("approval_mode", "auto");
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "solo", name: "Octopus" });
  companyId = team.company.id;
});

describe("checks before the specialists", () => {
  test("a failing check goes back to the main agent before any specialist runs, and the fix is checked and reviewed", async () => {
    writeProject({ test: "node check.mjs" });
    writeFileSync(path.join(dir, "check.mjs"), CHECK);
    const before = requests().length;
    script = (b) => {
      if (who(b)) return approve;
      if (lastUser(b).startsWith(BLOCK_PREFIX)) return outputs(b).length === 0 ? { calls: [{ name: "write_file", args: { path: "fixed.flag", content: "yes" } }] } : { text: "Fixed the check failure." };
      return outputs(b).length === 0 ? { calls: [{ name: "write_file", args: { path: "src/report.ts", content: lines(100) } }] } : { text: "Wrote the report." };
    };
    const id = await start("Add the report module");
    const done = await settle(id);
    expect(done.status).toBe("completed");
    const turn = requests().slice(before);
    const blockAt = turn.findIndex((b) => lastUser(b).startsWith(BLOCK_PREFIX));
    expect(blockAt).toBeGreaterThan(0);
    const firstSpecialist = turn.findIndex((b) => who(b) !== null);
    expect(firstSpecialist).toBeGreaterThan(blockAt);
    expect(turn.filter((b) => who(b) !== null).every((b) => !lastUser(b).includes("expected 2 got 1"))).toBe(true);
    const block = lastUser(turn[blockAt]!);
    expect(block.length).toBeLessThanOrEqual(6_000);
    expect(block).toContain("### test (`npm run test`) failed");
    expect(block).toContain("expected 2 got 1");
  }, 120_000);

  test("three failing-check messages at most: the fourth reply goes out incomplete, and no specialist spends a token", async () => {
    writeProject({ test: "node check.mjs" });
    writeFileSync(path.join(dir, "check.mjs"), CHECK);
    const before = requests().length;
    script = (b) => (outputs(b).length === 0 && !lastUser(b).startsWith(BLOCK_PREFIX) ? { calls: [{ name: "write_file", args: { path: "src/report.ts", content: lines(100) } }] } : { text: "Done." });
    const id = await start("Add the report module");
    const done = await settle(id);
    expect(done.status).toBe("incomplete");
    expect(done.halt_reason).toBe("Checks still fail after 3 check blocks: test.");
    const turn = requests().slice(before);
    expect(turn.filter((b) => lastUser(b).startsWith(BLOCK_PREFIX))).toHaveLength(3);
    expect(turn.filter((b) => who(b) !== null)).toHaveLength(0);
  }, 120_000);

  test("six check scripts all run, and the feed says none were left out", async () => {
    const scripts = { test: "node mark.mjs root-test", typecheck: "node mark.mjs root-typecheck", lint: "node mark.mjs root-lint" };
    const web = { test: "node ../mark.mjs web-test", typecheck: "node ../mark.mjs web-typecheck", lint: "node ../mark.mjs web-lint" };
    writeProject(scripts, { web });
    writeFileSync(path.join(dir, "mark.mjs"), "import { appendFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nappendFileSync(fileURLToPath(new URL('./ran.log', import.meta.url)), process.argv[2] + '\\n');\n");
    script = (b) => (who(b) ? approve : outputs(b).length === 0 ? { calls: [{ name: "write_file", args: { path: "src/report.ts", content: lines(100) } }] } : { text: "Wrote the report." });
    const id = await start("Add the report module");
    expect((await settle(id)).status).toBe("completed");
    const ran = readFileSync(path.join(dir, "ran.log"), "utf8").trim().split("\n").sort();
    expect(ran).toEqual(["root-lint", "root-test", "root-typecheck", "web-lint", "web-test", "web-typecheck"]);
    expect(events(id, "tool_call").filter((e) => e.tool === "run_code")).toHaveLength(6);
    const announced = (await messagesOf(id)).filter((m) => m.type === "status_update").map((m) => m.content);
    expect(announced.some((m) => m.includes("Left out: none."))).toBe(true);
  }, 180_000);

  test("a documents-only change runs no check and no specialist", async () => {
    writeProject({ test: "node mark.mjs root-test" });
    writeFileSync(path.join(dir, "mark.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('./ran.log', import.meta.url), 'ran\\n');\n");
    script = (b) => (outputs(b).length === 0 ? { calls: [{ name: "write_file", args: { path: "README.md", content: lines(100) } }] } : { text: "Documented." });
    const id = await start("Document the module");
    expect((await settle(id)).status).toBe("completed");
    expect(() => readFileSync(path.join(dir, "ran.log"))).toThrow();
    const announced = (await messagesOf(id)).filter((m) => m.type === "status_update");
    expect(announced).toHaveLength(0);
  }, 120_000);
});

describe("the check cap", () => {
  test("a project with more than eight checks runs the first eight and names the rest", () => {
    const script1 = { test: "node a.js", typecheck: "node a.js", lint: "node a.js" };
    writeProject(script1, { a: script1, b: script1, c: script1 });
    const { run, left } = verificationChecks(new ProjectFs(dir));
    expect(run).toHaveLength(8);
    expect(left.map((c) => c.name)).toEqual(["lint", "a: lint", "b: lint", "c: lint"]);
  });
});
