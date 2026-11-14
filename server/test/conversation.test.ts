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
  expect(lena[0]!.input).toContain("Files you own");
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
