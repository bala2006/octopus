/** End to end through the HTTP API with a scripted model: staffing, tasks, review, verification, report, follow-ups, safety. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasOut, MessageOut, PendingApproval, RunDetail, TaskOut, WorkspaceOut } from "@octopus/shared";
import { openRegistry, type Registry } from "../src/db/registry";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { fakeModel, outputs, turnKind, type FakeModel, type Script } from "./fakeModel";

let app: FastifyInstance;
let reg: Registry;
let model: FakeModel;
let script: Script = () => ({ text: "ok" });
let dir = "";
let ws: WorkspaceOut;

const call = async <T>(method: string, url: string, payload?: unknown): Promise<T> => {
  const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { host: "127.0.0.1" } });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
};
const W = () => `/api/v1/w/${ws.id}`;

async function until(runId: string, statuses: string[], ms = 15_000): Promise<RunDetail> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call<RunDetail>("GET", `${W()}/runs/${runId}`);
    if (statuses.includes(r.status)) return r;
    if (Date.now() > end) throw new Error(`run stayed ${r.status}: ${r.halt_reason}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

beforeAll(async () => {
  model = await fakeModel((b) => script(b));
  reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  app = await buildServer(reg);
});
afterAll(async () => { await app.close(); await model.close(); });

beforeEach(async () => {
  dir = path.join(process.env.TEST_BASE_DIR!, `p${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
  reg.setSetting("approval_mode", "auto");
});

/** A typical build: Octopus hires a developer, assigns the page, the reviewer approves. */
const buildScript: Script = (b) => {
  const kind = turnKind(b);
  const n = outputs(b).length;
  if (kind === "plan") return n === 0
    ? { calls: [{ name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "create_task", args: { title: "Build the landing page", description: "Create index.html with a hero section.", acceptance_criteria: "- index.html exists", assignee: "Lena", kind: "build" } }] }
    : { calls: [{ name: "start_work", args: { note: "Lena builds the page." } }] };
  if (kind === "work") return n === 0
    ? { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n", note: "Landing page" } }] }
    : { calls: [{ name: "complete_task", args: { summary: "Built index.html with the hero.", verification: "Opened the file" } }] };
  if (kind === "review") return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks good." } }] };
  return { text: "The landing page is ready in index.html." };
};

test("a request is staffed, built, reviewed and reported", async () => {
  script = buildScript;
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive", name: "Octopus" });
  expect(team.agents).toHaveLength(1);
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  const done = await until(run.id, ["completed", "incomplete", "failed"]);
  expect(done.status).toBe("completed");
  expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("Acme");

  const after = await call<CanvasOut>("GET", `${W()}/companies/${team.company.id}`);
  const roles = after.agents.map((a) => a.role).sort();
  expect(roles).toEqual(["Chief Orchestrator", "Frontend Developer", "Tech Lead / Reviewer"]);
  expect(after.revision).toBeGreaterThan(team.revision);

  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.map((t) => [t.kind, t.status])).toEqual([["build", "done"], ["review", "done"]]);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.map((m) => m.type)).toEqual(expect.arrayContaining(["task", "decision", "status_update", "review_request", "review_result", "final_report"]));
  expect(messages.at(-1)!.content).toContain("index.html");
  const artifacts = await call<{ path: string; version: number }[]>("GET", `${W()}/runs/${run.id}/artifacts`);
  expect(artifacts).toEqual([expect.objectContaining({ path: "index.html", version: 1 })]);
  expect(done.tokens_used).toBeGreaterThan(0);
});

test("a follow-up continues the same conversation and team", async () => {
  script = buildScript;
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  await until(run.id, ["completed"]);
  script = (b) => (turnKind(b) === "plan" ? { calls: [{ name: "reply_to_user", args: { message: "It uses plain HTML." } }] } : { text: "?" });
  await call("POST", `${W()}/runs/${run.id}/continue`, { content: "What stack is it?" });
  await new Promise((r) => setTimeout(r, 300));
  const r = await until(run.id, ["completed"]);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.at(-1)).toMatchObject({ type: "final_report", content: "It uses plain HTML." });
  expect(r.id).toBe(run.id);
});

test("review requests changes, the author revises, and the project's tests run", async () => {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node check.js" } }));
  writeFileSync(path.join(dir, "check.js"), "process.exit(require('fs').readFileSync('index.html','utf8').includes('Pricing') ? 0 : 1)");
  let reviews = 0;
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const brief = JSON.stringify(b.input);
    if (kind === "review") return { calls: [{ name: "submit_review", args: reviews++ === 0 ? { verdict: "request_changes", comments: "1. Add a pricing section." } : { verdict: "approve", comments: "Good." } }] };
    if (kind === "work" && brief.includes("Checks failed") === false && brief.includes("checks fail")) {
      return n === 0 ? { calls: [{ name: "read_file", args: { path: "index.html" } }] } : n === 1
        ? { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1><section>Pricing</section>\n" } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Fixed the failing check.", verification: "npm test" } }] };
    }
    if (kind === "work") {
      const revising = brief.includes("Review feedback to address");
      if (n === 0) return revising ? { calls: [{ name: "read_file", args: { path: "index.html" } }] } : { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n" } }] };
      if (revising && n === 1) return { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "<h1>Acme</h1>", new_string: "<h1>Acme</h1><p>Plans</p>" } }] };
      return { calls: [{ name: "complete_task", args: { summary: revising ? "Added the plans section." : "Built the landing page.", verification: "read it" } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Landing page" });
  const done = await until(run.id, ["completed", "incomplete"]);
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.map((t) => t.kind)).toEqual(["fix", "review", "review", "fix", "review"]);
  expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("Pricing");
  expect(done.status).toBe("completed");
  expect((done.state as { verification: { ok: boolean }[] }).verification.every((v) => v.ok)).toBe(true);
});

test("in ask mode, editing your files waits for approval; destructive commands never run", async () => {
  reg.setSetting("approval_mode", "ask");
  writeFileSync(path.join(dir, "notes.txt"), "mine\n");
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    if (kind === "plan") return n === 0
      ? { calls: [{ name: "hire_agent", args: { role_key: "developer", title: "Developer", department: "Engineering", reason: "Tidies files" } },
        { name: "create_task", args: { title: "Tidy notes", description: "Rewrite notes.txt and clean up.", acceptance_criteria: "- done", assignee: "Alex", kind: "docs" } }] }
      : { calls: [{ name: "start_work", args: { note: "go" } }] };
    if (kind === "work") return n === 0 ? { calls: [{ name: "run_command", args: { command: "rm -rf ." } }] }
      : n === 1 ? { calls: [{ name: "read_file", args: { path: "notes.txt" } }] }
      : n === 2 ? { calls: [{ name: "write_file", args: { path: "notes.txt", content: "tidy\n" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Tidied notes.txt.", verification: "read it" } }] };
    return { text: "Done." };
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Tidy my notes" });
  let approval: PendingApproval | undefined;
  for (let i = 0; i < 200 && !approval; i++) {
    const events = await call<{ type: string; payload: PendingApproval }[]>("GET", `${W()}/runs/${run.id}/events`);
    approval = events.find((e) => e.type === "approval_requested")?.payload;
    if (!approval) await new Promise((r) => setTimeout(r, 50));
  }
  expect(approval!).toMatchObject({ kind: "write_file", risk: "medium", details: { path: "notes.txt", old: "mine\n", new: "tidy\n" } });
  expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("mine\n");
  await call("POST", `${W()}/runs/${run.id}/approve`, { approval_id: approval!.id, approved: true });
  await until(run.id, ["completed", "incomplete"]);
  expect(readFileSync(path.join(dir, "notes.txt"), "utf8")).toBe("tidy\n");
  expect(existsSync(path.join(dir, ".octopus"))).toBe(true);
  const refused = model.requests.flatMap((r) => outputs(r)).find((o) => String(o.output).startsWith("Refused"));
  expect(refused?.output).toContain("rm is not allowed");
});

test("the canvas rejects a stale save after a hire", async () => {
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "solo_engineer" });
  const saved = await call<CanvasOut>("PUT", `${W()}/companies/${team.company.id}/canvas`, { agents: team.agents, edges: team.edges, revision: team.revision });
  expect(saved.revision).toBe(team.revision + 1);
  const res = await app.inject({ method: "PUT", url: `${W()}/companies/${team.company.id}/canvas`, headers: { host: "127.0.0.1" }, payload: { agents: [], edges: [], revision: team.revision } });
  expect(res.statusCode).toBe(409);
});

test("a review without a verdict is retried, then blocks the work instead of approving it", async () => {
  script = (b) => (turnKind(b) === "review" ? { text: "Looks fine I guess." } : buildScript(b));
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  const done = await until(run.id, ["completed", "incomplete"]);
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(done.status).toBe("incomplete");
  expect(tasks.map((t) => [t.kind, t.status])).toEqual([["build", "blocked"], ["review", "blocked"]]);
  expect(tasks[1]!.attempts).toBe(2);
});

test("limits apply per request: after a halt, the next message gets a fresh budget", async () => {
  script = buildScript;
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page", budget: { max_turns: 4 } });
  const halted = await until(run.id, ["incomplete", "completed"]);
  expect(halted.halt_reason).toMatch(/limit of 4 model calls/);
  script = (b) => (turnKind(b) === "plan" ? { calls: [{ name: "reply_to_user", args: { message: "Finishing the review now." } }] } : buildScript(b));
  // the follow-up is answered, and the unfinished build resumes within the new request's budget
  await call("POST", `${W()}/runs/${run.id}/continue`, { content: "Please finish." });
  await new Promise((r) => setTimeout(r, 200));
  const next = await until(run.id, ["completed", "incomplete"]);
  expect(next.status).toBe("completed");
  expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("Acme");
});

test("resuming a finished conversation leaves it finished", async () => {
  script = (b) => (turnKind(b) === "plan" ? { calls: [{ name: "reply_to_user", args: { message: "Hello." } }] } : { text: "?" });
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Hi" });
  await until(run.id, ["completed"]);
  await call("POST", `${W()}/runs/${run.id}/control/resume`);
  await new Promise((r) => setTimeout(r, 100));
  expect((await call<RunDetail>("GET", `${W()}/runs/${run.id}`)).status).toBe("completed");
});

test("sandboxed pages cannot change anything", async () => {
  const res = await app.inject({ method: "POST", url: "/api/v1/workspaces", headers: { host: "127.0.0.1", origin: "null" }, payload: { path: dir } });
  expect(res.statusCode).toBe(403);
  const other = await app.inject({ method: "POST", url: "/api/v1/workspaces", headers: { host: "127.0.0.1", origin: "https://evil.example" }, payload: { path: dir } });
  expect(other.statusCode).toBe(403);
  const get = await app.inject({ method: "GET", url: "/api/health", headers: { host: "127.0.0.1", origin: "null" } });
  expect(get.statusCode).toBe(200);
});
