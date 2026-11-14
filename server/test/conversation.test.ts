/** End to end through the HTTP API with a scripted model: staffing, tasks, review, verification, report, follow-ups, safety. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasOut, MessageOut, PendingApproval, RunDetail, TaskOut, WorkspaceOut } from "@octopus/shared";
import { openRegistry, type Registry } from "../src/db/registry";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { publish } from "../src/engine/bus";
import { Conversation } from "../src/engine/conversation";
import { openProject } from "../src/db/project";
import { project } from "../src/workspace/projects";
import { stopAll } from "../src/workspace/processes";
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
  if (kind === "acceptance") {
    const ids = [...new Set(JSON.stringify(b.input).match(/- (R\d+):/g)?.map((m) => m.slice(2, -1)) ?? [])];
    return { calls: [{ name: "submit_acceptance", args: { results: ids.map((id) => ({ id, met: true, evidence: "Saw it work." })) } }] };
  }
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

test("a worker that keeps testing is told to wrap up, then finishes instead of running out of steps", async () => {
  script = (b) => {
    if (turnKind(b) !== "work") return buildScript(b);
    if (!JSON.stringify(b.input).includes("almost out of steps")) return { calls: [{ name: "read_file", args: { path: "index.html" } }] };
    return { calls: [{ name: "complete_task", args: { summary: "Stopped testing and finished the page.", verification: "Read the file once more." } }] };
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  const done = await until(run.id, ["completed", "incomplete"]);
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(done.status).toBe("completed");
  expect(tasks.find((t) => t.kind === "build")?.status).toBe("done");
}, 30_000);
test("large files are read in pages, unchanged re-reads cost one line, lockfiles are not read whole", async () => {
  writeFileSync(path.join(dir, "big.js"), Array.from({ length: 2000 }, (_, i) => `const line${i} = "${"x".repeat(30)}";`).join("\n"));
  writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }, null, 2));
  const reads = [
    { path: "big.js" }, { path: "big.js" }, { path: "big.js", start_line: 1500 }, { path: "package-lock.json" },
  ];
  let seen: { output?: string }[] = [];
  script = (b) => {
    if (turnKind(b) !== "work") return buildScript(b);
    const n = outputs(b).length;
    if (n === 0) return { calls: [{ name: "read_file", args: reads[0]! }] };
    if (n < reads.length) return { calls: [{ name: "read_file", args: reads[n]! }] };
    seen = outputs(b);
    return { calls: [{ name: "complete_task", args: { summary: "Read the files it needed.", verification: "Read them" } }] };
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Look at big.js" });
  await until(run.id, ["completed", "incomplete"]);
  const [first, again, tail, lock] = seen.map((o) => String(o.output));
  expect(first).toMatch(/^big\.js \(2000 lines, showing 1-\d+; continue with start_line \d+\)/);
  expect(first!.length).toBeLessThan(41_000);
  expect(again).toMatch(/have not changed since you read them/);
  expect(tail).toMatch(/^big\.js \(2000 lines, showing 1500-2000\)/);
  expect(lock).toMatch(/generated file/);
});

test("a revision continues the author's session, and the re-review sees only the change since the review", async () => {
  const page = Array.from({ length: 200 }, (_, i) => `<p>Section ${i}</p>`).join("\n");
  const requests: { kind: string; input: { role?: string; content?: unknown; type?: string; name?: string }[] }[] = [];
  let reviews = 0;
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    if (kind === "work" || kind === "review") requests.push({ kind, input: b.input });
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    if (kind === "work") {
      if (last.includes("again:")) return n === 0
        ? { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "<p>Section 7</p>", new_string: "<p>Pricing</p>" } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Replaced section 7 with pricing.", verification: "Re-read the change" } }] };
      return n === 0 ? { calls: [{ name: "write_file", args: { path: "index.html", content: page } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Built the page.", verification: "Opened it" } }] };
    }
    if (kind === "review") {
      if (reviews === 0 && n === 0) return { calls: [{ name: "read_file", args: { path: "index.html" } }] };
      return { calls: [{ name: "submit_review", args: reviews++ === 0 ? { verdict: "request_changes", comments: "1. index.html: section 7 should be pricing." } : { verdict: "approve", comments: "Resolved." } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Landing page" });
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("completed");
  const lastUser = (r: (typeof requests)[number]) => JSON.stringify(r.input.findLast((i) => i.role === "user"));

  const revision = requests.find((r) => r.kind === "work" && lastUser(r).includes("again:"))!;
  expect(JSON.stringify(revision.input[0])).toContain("# T1: Build the landing page");
  expect(revision.input.some((i) => i.type === "function_call" && i.name === "write_file")).toBe(true);
  expect(lastUser(revision)).toContain("section 7 should be pricing");

  const reReview = requests.find((r) => r.kind === "review" && lastUser(r).includes("Re-review"))!;
  expect(reReview.input.some((i) => i.type === "function_call" && i.name === "submit_review")).toBe(true);
  expect(lastUser(reReview)).toContain("Pricing");
  expect(lastUser(reReview)).not.toContain("Section 150");
});

test("requirements must all be owned or cut, owned paths let builders run in parallel, and a task's skills reach its builder", async () => {
  const work: { who: string; input: string; instructions: string; n: number }[] = [];
  let planOutputs: string[] = [];
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const brief = JSON.stringify(b.input[0]);
    if (kind === "plan") {
      if (n === 5) planOutputs = outputs(b).map((o) => String(o.output));
      if (n === 0) return { calls: [
        { name: "set_requirements", args: { items: ["A red home page", "A blue about page", "Native 8K output"] } },
        { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Home page" } },
        { name: "hire_agent", args: { title: "Three.js Game Developer", department: "Engineering", reason: "About page" } },
        { name: "create_task", args: { title: "Build the home page", description: "Write src/home/index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["src/home/"] } },
        { name: "start_work", args: { note: "Go." } }] };
      if (n === 5) return { calls: [
        { name: "cut_requirement", args: { id: "R3", reason: "Browsers cannot render native 8K here; it adapts to the screen instead." } },
        { name: "create_task", args: { title: "Build the about page", description: "Write src/about/index.html.", acceptance_criteria: "- exists", assignee: "Alex", kind: "build", requirements: ["R2"], files: ["src/about"], skills: ["web-game"] } },
        { name: "start_work", args: { note: "Go." } }] };
      return { text: "?" };
    }
    if (kind === "work") {
      const who = brief.includes("# T1: Build the home page") ? "Lena" : "Alex";
      work.push({ who, input: brief, instructions: b.instructions, n });
      if (who === "Lena") return n === 0 ? { calls: [{ name: "write_file", args: { path: "src/home/index.html", content: "<h1>Home</h1>" } }] }
        : n === 1 ? { calls: [{ name: "write_file", args: { path: "src/about/extra.html", content: "mine now" } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Built the home page.", verification: "Opened it" } }] };
      return n === 0 ? { calls: [{ name: "write_file", args: { path: "src/about/index.html", content: "<h1>About</h1>" } }] }
        : n < 4 ? { calls: [{ name: "read_file", args: { path: "src/about/index.html", start_line: n } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Built the about page.", verification: "Opened it" } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A red home page, a blue about page, in native 8K" });
  await until(run.id, ["completed", "incomplete"]);

  expect(planOutputs[4]).toMatch(/No task delivers R2 \(A blue about page\), R3 \(Native 8K output\)/);
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.filter((t) => t.kind === "build").map((t) => [t.key, t.requirements, t.files])).toEqual([["T1", ["R1"], ["src/home"]], ["T2", ["R2"], ["src/about"]]]);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.find((m) => m.type === "decision")?.content).toContain("R3 Native 8K output: Browsers cannot render native 8K");

  const lena = work.filter((w) => w.who === "Lena");
  const ava = work.filter((w) => w.who === "Alex");
  expect(lena[0]!.input).toContain("R1: A red home page");
  expect(lena[0]!.input).toContain("Your part");
  expect(ava[0]!.instructions).toContain("# Web game");
  expect(work.indexOf(ava[0]!)).toBeLessThan(work.indexOf(lena.at(-1)!)); // both ran at once
  expect(existsSync(path.join(dir, "src/about/extra.html"))).toBe(false);
  const refused = model.requests.flatMap((r) => outputs(r)).find((o) => String(o.output).includes("belongs to T2"));
  expect(refused?.output).toContain("src/about/extra.html belongs to T2 (Alex)");
});

test("a small document a task depends on is handed over in its brief, so it is not read again", async () => {
  const spec = "# Spec\n\nThe page says hello.\n";
  let builderBrief = "";
  let reread = "";
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "hire_agent", args: { role_key: "pm", title: "Product Manager", department: "Product", reason: "Writes the spec" } },
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "create_task", args: { title: "Write the spec", description: "Write .octopus/work/spec.md.", acceptance_criteria: "- exists", assignee: "Priya", kind: "docs", files: [".octopus/work/spec.md"] } },
      { name: "create_task", args: { title: "Build the page", description: "Build index.html from the spec.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", depends_on: ["T1"], files: ["index.html"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Spec, then page." } }] };
    if (kind === "work" && JSON.stringify(b.input[0]).includes("# T1: Write the spec")) return n === 0
      ? { calls: [{ name: "write_file", args: { path: ".octopus/work/spec.md", content: spec } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Wrote the spec.", verification: "Re-read it" } }] };
    if (kind === "work") {
      builderBrief = JSON.stringify(b.input[0]);
      if (n === 0) return { calls: [{ name: "read_file", args: { path: ".octopus/work/spec.md" } }] };
      if (n === 1) { reread = String(outputs(b)[0]!.output); return { calls: [{ name: "write_file", args: { path: "index.html", content: "<p>hello</p>" } }] }; }
      return { calls: [{ name: "complete_task", args: { summary: "Built the page.", verification: "Opened it" } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A hello page" });
  await until(run.id, ["completed", "incomplete"]);
  expect(builderBrief).toContain("The page says hello.");
  expect(reread).toMatch(/have not changed since you read them/);
});

test("the result is checked against the requirements; what fails goes back to its builder until it passes", async () => {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "node server.js" } }));
  writeFileSync(path.join(dir, "server.js"), "console.log('  Local:   http://localhost:4321/');\nsetInterval(() => {}, 1000);\n");
  const seen: { kind: string; last: string; input: unknown[]; outputs: string[] }[] = [];
  let checks = 0;
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    seen.push({ kind, last, input: b.input, outputs: outputs(b).map((o) => String(o.output)) });
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "set_requirements", args: { items: ["A pricing section"] } },
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "create_task", args: { title: "Build the landing page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["index.html"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Lena builds it." } }] };
    if (kind === "work" && last.includes("Make R1 work")) return n === 0
      ? { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "<h1>Acme</h1>", new_string: "<h1>Acme</h1><section>Pricing</section>" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Added the pricing section.", verification: "Opened it" } }] };
    if (kind === "acceptance") {
      if (checks === 0 && n === 0) return { calls: [{ name: "start_dev_server", args: {} }] };
      const met = checks++ > 0;
      return { calls: [{ name: "submit_acceptance", args: { results: [{ id: "R1", met, evidence: met ? "The pricing section shows." : "There is no pricing section on the page." }] } }] };
    }
    return buildScript(b);
  };
  try {
    const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
    const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A landing page with a pricing section" });
    const done = await until(run.id, ["completed", "incomplete"]);
    expect(done.status).toBe("completed");
    const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
    expect(tasks.map((t) => [t.kind, t.status])).toEqual([
      ["build", "done"], ["review", "done"], ["verify", "done"], ["fix", "done"], ["review", "done"], ["verify", "done"]]);
    expect(tasks[2]!.result).toContain("R1 not met: There is no pricing section");
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("Pricing");

    const firstCheck = seen.find((s) => s.kind === "acceptance" && s.outputs.length === 1)!;
    expect(firstCheck.outputs[0]).toContain("is running at http://localhost:4321/");
    const fix = seen.find((s) => s.kind === "work" && s.last.includes("Make R1 work"))!;
    expect(JSON.stringify(fix.input[0])).toContain("# T1: Build the landing page"); // the builder's own session
    expect(fix.last).toContain("There is no pricing section");
    const recheck = seen.find((s) => s.kind === "acceptance" && s.last.includes("Acceptance check again"))!;
    expect(recheck.last).toContain("R1: A pricing section");
    const state = done.state as { requirements: { id: string; status: string }[] };
    expect(state.requirements).toEqual([expect.objectContaining({ id: "R1", status: "met" })]);
    const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
    expect(messages.at(-1)!.content).toContain("| R1 | A pricing section | Met | The pricing section shows. |");
  } finally {
    stopAll();
  }
}, 30_000);

test("review comments still open at the revision limit are listed in the report, not hidden", async () => {
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    if (kind === "review") return { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "1. index.html: the footer is missing." } }] };
    if (kind === "work") return n === 0
      ? { calls: [{ name: "write_file", args: { path: "index.html", content: `<h1>Acme ${Math.random()}</h1>\n` } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Built and revised the page.", verification: "Opened it" } }] };
    if (kind === "report") return { text: "The page is built and the footer was added." };
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  await until(run.id, ["completed", "incomplete"]);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.at(-1)!.content).toMatch(/### Still open\n- T1 Build the landing page: review comments still open after 2 revisions: Kai \(code review\): 1\. index\.html: the footer is missing\./);
});

test("a message sent while a task runs is planned at once, and amend_task reaches the running builder and its reviewer", async () => {
  writeFileSync(path.join(dir, "wait.js"), "setTimeout(() => {}, 1500);\n");
  let runId = "";
  let builderSaw = "";
  let reviewBrief = "";
  let posted = false;
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const all = JSON.stringify(b.input);
    if (kind === "plan" && all.includes("Use three.js")) return n === 0
      ? { calls: [{ name: "amend_task", args: { task: "T1", note: "Use three.js for the hero." } }] }
      : { calls: [{ name: "reply_to_user", args: { message: "Told Lena." } }] };
    if (kind === "work") {
      if (n === 0) {
        if (!posted) { posted = true; setTimeout(() => void call("POST", `${W()}/runs/${runId}/continue`, { content: "Use three.js" }), 100); }
        return { calls: [{ name: "run_command", args: { command: "node wait.js" } }] };
      }
      if (n === 1) { builderSaw = JSON.stringify(b.input); return { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n" } }] }; }
      return { calls: [{ name: "complete_task", args: { summary: "Built the page with three.js.", verification: "Opened it" } }] };
    }
    if (kind === "review") reviewBrief = JSON.stringify(b.input[0]);
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  runId = run.id;
  await new Promise((r) => setTimeout(r, 300));
  await until(run.id, ["completed", "incomplete"]);
  expect(builderSaw).toContain("Update from Octopus on T1");
  expect(builderSaw).toContain("Use three.js for the hero.");
  expect(reviewBrief).toContain("Use three.js for the hero.");
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.filter((t) => t.kind === "build")).toHaveLength(1);
});

test("a follow-up is accepted against its own requirements, not the earlier request's", async () => {
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    if (kind === "plan" && last.includes("Rename")) return n === 0
      ? { calls: [{ name: "create_task", args: { title: "Rename the title", description: "Change the h1 in index.html.", acceptance_criteria: "- renamed", assignee: "Lena", kind: "build", files: ["index.html"] } }] }
      : { calls: [{ name: "start_work", args: { note: "Lena renames it." } }] };
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "set_requirements", args: { items: ["A pricing section"] } },
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "create_task", args: { title: "Build the landing page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["index.html"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Lena builds it." } }] };
    if (kind === "work" && last.includes("Rename")) return outputs(b).length === 0
      ? { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "Acme", new_string: "Acme Inc" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Renamed the title.", verification: "Read it" } }] };
    if (kind === "work" && last.includes("Make R1 work")) return { calls: [{ name: "complete_task", args: { summary: "Could not add pricing.", verification: "none" } }] };
    if (kind === "acceptance") return { calls: [{ name: "submit_acceptance", args: { results: [{ id: "R1", met: false, evidence: "No pricing section." }] } }] };
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A landing page with pricing" });
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("incomplete");
  const before = (await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`)).length;
  await call("POST", `${W()}/runs/${run.id}/continue`, { content: "Rename the title to Acme Inc" });
  await new Promise((r) => setTimeout(r, 300));
  const done = await until(run.id, ["completed", "incomplete"]);
  const later = (await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`)).slice(before);
  expect(later.map((t) => t.kind)).toEqual(["build", "review"]);
  expect(done.status).toBe("completed");
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.at(-1)!.content).not.toContain("### Requirements");
});

test("a blocked acceptance check is not queued again until something changes", async () => {
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "set_requirements", args: { items: ["A pricing section"] } },
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "create_task", args: { title: "Build the landing page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["index.html"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Lena builds it." } }] };
    if (kind === "acceptance") return { calls: [{ name: "block_task", args: { reason: "The page does not load in the browser here." } }] };
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A landing page with pricing" });
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("incomplete");
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.filter((t) => t.kind === "verify").map((t) => t.status)).toEqual(["blocked"]);
});

test("an idle teammate answers from its own session, and pins reach the briefs of tasks on their paths", async () => {
  const seen: { last: string; first: string; tools: string[] }[] = [];
  let alexGot = "";
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const first = JSON.stringify(b.input[0]);
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the shell" } },
      { name: "hire_agent", args: { role_key: "backend", title: "Backend Developer", department: "Engineering", reason: "Builds the API" } },
      { name: "create_task", args: { title: "Build the API", description: "Write src/api/index.js.", acceptance_criteria: "- exists", assignee: "Diego", kind: "build", files: ["src/api"] } },
      { name: "create_task", args: { title: "Build the client", description: "Write src/web/app.js against the API.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", files: ["src/web"], depends_on: ["T1"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "API, then client." } }] };
    if (kind === "work" || kind === "consult") seen.push({ last, first, tools: (b.tools ?? []).map((t: { name: string }) => t.name) });
    const answering = /Message (\w+) from Lena/.exec(last);
    if (answering) return { calls: [{ name: "reply", args: { message_id: answering[1], text: "Blue, #2244ff." } }] };
    if (kind === "work" && first.includes("# T1: Build the API")) return n === 0
      ? { calls: [{ name: "write_file", args: { path: "src/api/index.js", content: "export const color = '#2244ff';\n" } }, { name: "pin", args: { key: "contract: api", text: "GET /color returns { color: string }", paths: ["src/api", "src/web"] } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Built the API.", verification: "Read it" } }] };
    if (kind === "work" && first.includes("Build the client")) {
      if (n === 0) return { calls: [{ name: "message", args: { to: "Diego", text: "Which brand colour does the API return?", wait: true } }] };
      if (n === 1) { alexGot = String(outputs(b)[0]!.output); return { calls: [{ name: "write_file", args: { path: "src/web/app.js", content: "// blue\n" } }] }; }
      return { calls: [{ name: "complete_task", args: { summary: "Built the client.", verification: "Read it" } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "An API and a client" });
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("completed");

  const clientBrief = seen.find((s) => s.first.includes("# T2: Build the client"))!;
  expect(clientBrief.first).toContain("Pinned in the team chat");
  expect(clientBrief.first).toContain("GET /color returns { color: string }");
  expect(clientBrief.tools).toEqual(expect.arrayContaining(["message", "reply", "pin"]));
  const answer = seen.find((s) => /Message \w+ from Lena/.test(s.last))!;
  expect(answer.first).toContain("# T1: Build the API"); // Diego answered inside his own session
  expect(alexGot).toBe("Diego replied: Blue, #2244ff.");
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.filter((m) => ["question", "answer", "decision"].includes(m.type)).map((m) => m.type)).toEqual(expect.arrayContaining(["decision", "question", "answer"]));
});

test("a teammate's edit reaches the agent that read the file, and its re-read returns the new content", async () => {
  writeFileSync(path.join(dir, "shared.txt"), "version one\n");
  writeFileSync(path.join(dir, "wait.js"), "setTimeout(() => {}, Number(process.argv[2] ?? 1000));\n");
  const steps: Record<string, number> = {};
  let notice = "";
  let reread = "";
  script = (b) => {
    const kind = turnKind(b);
    if (kind === "plan") return outputs(b).length === 0 ? { calls: [
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds part A" } },
      { name: "hire_agent", args: { role_key: "backend", title: "Backend Developer", department: "Engineering", reason: "Builds part B" } },
      { name: "create_task", args: { title: "Build part A", description: "Work in src/a.", acceptance_criteria: "- done", assignee: "Lena", kind: "build", files: ["src/a"] } },
      { name: "create_task", args: { title: "Build part B", description: "Work in src/b.", acceptance_criteria: "- done", assignee: "Diego", kind: "build", files: ["src/b"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Both at once." } }] };
    if (kind !== "work") return buildScript(b);
    const who = JSON.stringify(b.input[0]).includes("part A") ? "lena" : "diego";
    const step = (steps[who] = (steps[who] ?? 0) + 1);
    if (who === "diego") return step === 1 ? { calls: [{ name: "run_command", args: { command: "node wait.js 600" } }] }
      : step === 2 ? { calls: [{ name: "read_file", args: { path: "shared.txt" } }] }
      : step === 3 ? { calls: [{ name: "write_file", args: { path: "shared.txt", content: "version two\n" } }, { name: "write_file", args: { path: "src/b/x.txt", content: "b\n" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Built part B.", verification: "Read it" } }] };
    if (step === 1) return { calls: [{ name: "read_file", args: { path: "shared.txt" } }] };
    if (step === 2) return { calls: [{ name: "run_command", args: { command: "node wait.js 2500" } }] };
    if (step === 3) { notice = JSON.stringify(b.input.slice(-1)); return { calls: [{ name: "read_file", args: { path: "shared.txt" } }] }; }
    if (step === 4) { reread = String(outputs(b).at(-1)?.output); return { calls: [{ name: "write_file", args: { path: "src/a/y.txt", content: "a\n" } }] }; }
    return { calls: [{ name: "complete_task", args: { summary: "Built part A.", verification: "Read it" } }] };
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Two parts" });
  await until(run.id, ["completed", "incomplete"]);
  expect(notice).toContain("shared.txt was changed by Diego");
  expect(reread).toContain("version two");
}, 30_000);

test("specialists sharpen a part in parallel, and the owner gets all their feedback in one revision", async () => {
  const reviews: { who: string; first: string; tools: string[] }[] = [];
  const revisions: string[] = [];
  const round: Record<string, number> = {};
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const first = JSON.stringify(b.input[0]);
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    if (kind === "plan") return n === 0 ? { calls: [
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Owns the page" } },
      { name: "hire_agent", args: { role_key: "designer", title: "Art Director", department: "Product & Design", reason: "Sharpens the look" } },
      { name: "hire_agent", args: { role_key: "qa", title: "QA Engineer", department: "Quality & Ops", reason: "Plays it" } },
      { name: "create_task", args: { title: "Build the landing page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", files: ["index.html"], specialists: ["Iris", "Sam"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Lena builds; Iris and Sam sharpen it." } }] };
    if (kind === "review") {
      const who = /\(by Lena|revision \d+ by Lena/.test(first + last) ? (b.instructions.match(/You are (\w+),/)?.[1] ?? "?") : "?";
      if (n === 0) reviews.push({ who, first, tools: (b.tools ?? []).map((t: { name: string }) => t.name) });
      const r = (round[who] = (round[who] ?? 0) + (n === 0 ? 1 : 0));
      const ask = r === 1 && who !== "Kai" ? { verdict: "request_changes", comments: who === "Iris" ? "1. The hero should be red." : "1. The button does nothing." } : { verdict: "approve", comments: "Good." };
      return { calls: [{ name: "submit_review", args: ask }] };
    }
    if (kind === "work" && last.includes("again:")) {
      if (n === 0) { revisions.push(last); return { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "<h1>Acme</h1>", new_string: "<h1 style=\"color:red\">Acme</h1><button onclick=\"go()\">Go</button>" } }] }; }
      return { calls: [{ name: "complete_task", args: { summary: "Made the hero red and wired the button.", verification: "Opened it" } }] };
    }
    if (kind === "acceptance") return { calls: [{ name: "submit_acceptance", args: { results: [] } }] };
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("completed");
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.filter((t) => t.kind === "review").map((t) => t.title.split(" T1")[0]).sort())
    .toEqual(["Play review", "Play review", "Review", "Review", "Visual review", "Visual review"]);
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toContain("### Iris (art direction)");
  expect(revisions[0]).toContain("The hero should be red");
  expect(revisions[0]).toContain("### Sam (play testing)");
  expect(revisions[0]).not.toContain("### Kai");
  const iris = reviews.find((r) => r.who === "Iris")!;
  expect(iris.first).toContain("Your lens: art direction");
  expect(iris.tools).toContain("read_file"); // a visual review is never a diff-only quick review
  expect(tasks.find((t) => t.kind === "fix")?.status).toBe("done");
}, 30_000);

test("a long turn summarizes its earlier work and keeps going, and repeating the same call gets a reminder", async () => {
  const { contextLimits, CHECKPOINT_REQUEST } = await import("../src/engine/agent");
  const saved = { ...contextLimits };
  Object.assign(contextLimits, { summarizeAt: 30_000, keepTail: 8_000 });
  writeFileSync(path.join(dir, "big.js"), Array.from({ length: 1000 }, (_, i) => `const v${i} = "${"y".repeat(40)}";`).join("\n"));
  let step = 0;
  let checkpointAsked = 0;
  let afterSummary = "";
  let reminder = "";
  try {
    script = (b) => {
      if (turnKind(b) !== "work") return buildScript(b);
      const last = JSON.stringify(b.input.at(-1));
      if (last.includes(CHECKPOINT_REQUEST.slice(0, 40))) { checkpointAsked++; return { text: "## Done\nRead big.js in parts.\n## Next\nWrite index.html." }; }
      step++;
      if (JSON.stringify(b.input).includes("<checkpoint>") && !afterSummary) afterSummary = JSON.stringify(b.input);
      if (step <= 3) {
        if (step === 3) reminder = "";
        return { calls: [{ name: "run_command", args: { command: "node --version" } }] };
      }
      if (step === 4) reminder = JSON.stringify(b.input.at(-1));
      if (step < 12) return { calls: [{ name: "read_file", args: { path: "big.js", start_line: (step - 4) * 100 + 1, end_line: (step - 3) * 100 } }] };
      if (step === 12) return { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n" } }] };
      return { calls: [{ name: "complete_task", args: { summary: "Built the page after reading big.js.", verification: "Read it" } }] };
    };
    const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
    const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
    expect((await until(run.id, ["completed", "incomplete"])).status).toBe("completed");
  } finally {
    Object.assign(contextLimits, saved);
  }
  expect(reminder).toContain("same run_command call 3 times in a row");
  expect(checkpointAsked).toBeGreaterThan(0);
  expect(afterSummary).toContain("Write index.html.");
  expect(afterSummary).toContain("# T1: Build the landing page"); // the brief stays
  expect(afterSummary.length).toBeLessThan(30_000);
}, 30_000);

test("fragments are refused as requirements, and requirements never checked stay owed into the next request", async () => {
  let planOutputs: string[] = [];
  let builds = 0;
  script = (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const last = JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user"));
    if (kind === "plan" && last.includes("serve it")) return n === 0
      ? { calls: [{ name: "create_task", args: { title: "Integrate and serve", description: "Wire it up.", acceptance_criteria: "- runs", assignee: "Lena", kind: "build", files: ["index.html"] } }] }
      : { calls: [{ name: "start_work", args: { note: "Lena wires it up." } }] };
    if (kind === "plan") {
      if (n === 0) return { calls: [{ name: "set_requirements", args: { items: ["A sign reading", "EXIT", "on a hanging sign"] } }] };
      if (n === 1) { planOutputs = outputs(b).map((o) => String(o.output)); return { calls: [
        { name: "set_requirements", args: { items: ["A hanging sign reading \"EXIT\""] } },
        { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
        { name: "create_task", args: { title: "Build the sign", description: "Write src/sign.js.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["src"] } },
      ] }; }
      return { calls: [{ name: "start_work", args: { note: "Lena builds the sign." } }] };
    }
    if (kind === "work" && JSON.stringify(b.input[0]).includes("Build the sign")) return { calls: [{ name: "block_task", args: { reason: "The project has no package.json yet." } }] };
    if (kind === "work") { builds++; return outputs(b).length === 0
      ? { calls: [{ name: "write_file", args: { path: "index.html", content: "<p>EXIT</p>\n" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Wired and served it.", verification: "Opened it" } }] }; }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A hanging sign reading \"EXIT\"" });
  await until(run.id, ["completed", "incomplete"]);
  expect(planOutputs[0]).toMatch(/fragments, not whole asks: "EXIT"\. /);
  await call("POST", `${W()}/runs/${run.id}/continue`, { content: "finish the game fast, and serve it" });
  await new Promise((r) => setTimeout(r, 300));
  await until(run.id, ["completed", "incomplete"]);
  expect(builds).toBeGreaterThan(0);
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  const check = tasks.find((t) => t.kind === "verify");
  expect(check?.requirements).toEqual(["R1"]); // checked in the follow-up although no follow-up task names it
  const final = await call<RunDetail>("GET", `${W()}/runs/${run.id}`);
  expect((final.state as { requirements: { id: string }[] }).requirements.map((r) => r.id)).toEqual(["R1"]);
});

test("a message to one agent while the team works lands in that agent's own chat, not in a new plan", async () => {
  writeFileSync(path.join(dir, "wait.js"), "setTimeout(() => {}, 1500);\n");
  let runId = "";
  let lenaId = "";
  let saw = "";
  let posted = false;
  script = (b) => {
    const kind = turnKind(b);
    const all = JSON.stringify(b.input);
    if (kind === "work") {
      const msg = /Message (\w+) from the user/.exec(all);
      if (!posted) {
        posted = true;
        setTimeout(() => void call("POST", `${W()}/runs/${runId}/continue`, { content: "Make the heading say Hello", to_agent_id: lenaId }), 200);
        return { calls: [{ name: "run_command", args: { command: "node wait.js" } }] };
      }
      if (msg && !saw) { saw = all; return { calls: [{ name: "reply", args: { message_id: msg[1], text: "Will do: the heading now says Hello." } }, { name: "write_file", args: { path: "index.html", content: "<h1>Hello</h1>\n" } }] }; }
      return { calls: [{ name: "complete_task", args: { summary: "Built the page saying Hello.", verification: "Read it" } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  runId = run.id;
  for (let i = 0; i < 100 && !lenaId; i++) {
    lenaId = (await call<CanvasOut>("GET", `${W()}/companies/${team.company.id}`)).agents.find((a) => a.name === "Lena")?.id ?? "";
    if (!lenaId) await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 400));
  expect((await until(run.id, ["completed", "incomplete"])).status).toBe("completed");
  expect(saw).toContain("Make the heading say Hello");
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  expect(tasks.filter((t) => t.kind === "build")).toHaveLength(1);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.find((m) => m.type === "answer" && m.content.includes("Will do"))).toMatchObject({ from_agent_id: lenaId, to_agent_id: null });
}, 30_000);

test("a message that reaches an agent as it finishes is still answered, and asking an idle agent for work makes it a task in that agent's session", async () => {
  writeFileSync(path.join(dir, "wait.js"), "setTimeout(() => {}, Number(process.argv[2] ?? 1000));\n");
  let runId = "";
  const ids: Record<string, string> = {};
  const lenaRequests: string[] = [];
  let lenaStep = 0;
  let sentLate = false;
  let sentWork = false;
  script = (b) => {
    const kind = turnKind(b);
    const first = JSON.stringify(b.input[0]);
    const all = JSON.stringify(b.input);
    if (kind === "plan") return outputs(b).length === 0 ? { calls: [
      { name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Builds the page" } },
      { name: "hire_agent", args: { role_key: "backend", title: "Backend Developer", department: "Engineering", reason: "Builds the API" } },
      { name: "create_task", args: { title: "Build the page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", files: ["index.html"] } },
      { name: "create_task", args: { title: "Build the API", description: "Write api.js.", acceptance_criteria: "- exists", assignee: "Diego", kind: "build", files: ["api.js"] } },
    ] } : { calls: [{ name: "start_work", args: { note: "Both at once." } }] };
    if (kind === "work" && first.includes("Build the API")) {
      const n = outputs(b).length;
      if (n === 0) return { calls: [{ name: "run_command", args: { command: "node wait.js 4000" } }] };
      if (n === 1) return { calls: [{ name: "write_file", args: { path: "api.js", content: "export {};\n" } }] };
      return { calls: [{ name: "complete_task", args: { summary: "Built the API.", verification: "Read it" } }] };
    }
    if (b.instructions.includes("You are Lena,")) {
      lenaRequests.push(all);
      const late = /Message (\w+) from the user/.exec(JSON.stringify(b.input.at(-1)));
      if (late) return { calls: [{ name: "reply", args: { message_id: late[1], text: "Yes, the heading is final." } }] };
      if (all.includes("Add a footer") && JSON.stringify(b.input.findLast((i: { role?: string }) => i.role === "user")).includes("Add a footer")) {
        return outputs(b).length === 0 ? { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "</h1>", new_string: "</h1><footer>f</footer>" } }] }
          : { calls: [{ name: "complete_task", args: { summary: "Added the footer.", verification: "Read it" } }] };
      }
      if (kind === "work") {
        lenaStep++;
        if (lenaStep === 1) return { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n" } }] };
        if (!sentLate) {
          sentLate = true;
          setTimeout(() => void call("POST", `${W()}/runs/${runId}/continue`, { content: "Is the heading final?", to_agent_id: ids.Lena }), 100);
          // The message lands while this last step runs, after the inbox was read for it.
          return { calls: [{ name: "run_command", args: { command: "node wait.js 600" } }, { name: "complete_task", args: { summary: "Built the page.", verification: "Read it" } }] };
        }
        return { calls: [{ name: "complete_task", args: { summary: "Built the page.", verification: "Read it" } }] };
      }
    }
    if (kind === "review" && !sentWork && first.includes("Build the page")) {
      sentWork = true;
      setTimeout(() => void call("POST", `${W()}/runs/${runId}/continue`, { content: "Add a footer to the page", to_agent_id: ids.Lena }), 1200);
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "A page and an API" });
  runId = run.id;
  for (let i = 0; i < 100 && !ids.Lena; i++) {
    for (const a of (await call<CanvasOut>("GET", `${W()}/companies/${team.company.id}`)).agents) ids[a.name] = a.id;
    if (!ids.Lena) await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 2500));
  await until(run.id, ["completed", "incomplete"]);
  const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
  expect(messages.find((m) => m.type === "answer" && m.content.includes("heading is final"))).toBeTruthy();
  const tasks = await call<TaskOut[]>("GET", `${W()}/runs/${run.id}/tasks`);
  const footer = tasks.find((t) => t.title.startsWith("Add a footer"));
  expect(footer).toMatchObject({ assignee_agent_id: ids.Lena, kind: expect.stringMatching(/build|fix/) });
  const footerTurn = lenaRequests.find((r) => r.includes("Add a footer"))!;
  expect(footerTurn).toContain("# T1: Build the page"); // continues her own session
}, 30_000);

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

test("an approval left open by a restart is closed when the run loads again", async () => {
  script = (b) => (turnKind(b) === "plan" ? { calls: [{ name: "reply_to_user", args: { message: "Hello." } }] } : { text: "?" });
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Hi" });
  await until(run.id, ["completed"]);
  // A request that was waiting for an answer when the previous process stopped.
  const orphan: PendingApproval = { id: "orphan1", agent_id: team.agents[0]!.id, kind: "run_command", summary: "Run `npm test`",
    preview: "", details: { key: "npm" }, risk: "medium", level: "ask" };
  const current = project(reg, ws.id);
  publish(current.db, run.id, "approval_requested", orphan);
  // Loading the run in a new process: a fresh handle on the same database.
  Conversation.get({ ...current, db: openProject(dir) }, reg, run.id);
  const closed = () => current.db.events.find("run_id = ? AND type = 'approval_resolved'", [run.id], "seq");
  expect(closed().map((e) => e.data)).toMatchObject([{ id: "orphan1", approved: false }]);
  // Loading it again adds nothing.
  Conversation.get({ ...current, db: openProject(dir) }, reg, run.id);
  expect(closed()).toHaveLength(1);
});

test("a small change is reviewed from its diff in one step, with only the verdict tools", async () => {
  const reviews: { tools: { name: string }[]; input: unknown }[] = [];
  script = (b) => {
    if (turnKind(b) === "review") {
      reviews.push(b);
      return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks right." } }] };
    }
    return buildScript(b);
  };
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "adaptive" });
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build a landing page" });
  const done = await until(run.id, ["completed", "incomplete"]);
  expect(done.status).toBe("completed");
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.tools.map((t) => t.name).sort()).toEqual(["block_task", "submit_review"]);
  expect(JSON.stringify(reviews[0]!.input)).toMatch(/\+.*Acme/);
}, 30_000);
