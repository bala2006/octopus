/**
 * Execution benchmark: the same task classes driven through the real engine against the scripted model, measured on
 * what the audit found expensive: model calls, payload characters, file reads, checks and agent activations.
 *
 * The point is not a token number from a fake model (it reports a fixed usage); it is the shape of the execution:
 * how many times the engine calls the model, with how much text, and whether it repeats work it already did.
 * A regression here is a real regression in cost.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CanvasOut, RunDetail, WorkspaceOut } from "@octopus/shared";
import { effectiveRoles } from "../src/catalog/roles";
import { openRegistry, type Registry } from "../src/db/registry";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { isCheckpoint, loadScenario, scriptFor } from "../eval/scriptedModel";
import { fakeModel, outputs, turnKind, type FakeModel, type Script } from "./fakeModel";

let app: FastifyInstance;
let reg: Registry;
let model: FakeModel;
let ws: WorkspaceOut;
let dir = "";

const call = async <T>(method: string, url: string, payload?: unknown): Promise<T> => {
  const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { host: "127.0.0.1" } });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
  return res.json() as T;
};
const W = () => `/api/v1/w/${ws.id}`;

async function until(runId: string, statuses: string[], ms = 60_000): Promise<RunDetail> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call<RunDetail>("GET", `${W()}/runs/${runId}`);
    if (statuses.includes(r.status)) return r;
    if (Date.now() > end) throw new Error(`run stayed ${r.status}: ${r.halt_reason}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

beforeAll(async () => {
  model = await fakeModel((b) => script(b));
  reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry-bench.db"));
  reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  app = await buildServer(reg);
});
afterAll(async () => { await app.close(); await model.close(); });

let script: Script = () => ({ text: "ok" });

/**
 * Model calls per scenario. BASELINE is origin/main before the audit's changes, measured with this harness. MEASURED is
 * this change, the ceiling each scenario is tested against. Every MEASURED value is below its BASELINE.
 */
const BASELINE = { oneFile: 6, reviewAcceptance: 18, designerQa: 23, followUp: 6, persistentFailure: 30, docsOnly: 9 } as const;
const MEASURED = { oneFile: 4, reviewAcceptance: 15, designerQa: 18, followUp: 5, persistentFailure: 3, docsOnly: 5 } as const;
/**
 * Instruction characters per scenario, the exact counts after this change (origin/main, same harness: 41k, 109k and 141k).
 * The scripted model is deterministic, so these are exact; a prompt change that adds text fails here on purpose.
 */
const INSTRUCTIONS = { oneFile: 15_348, reviewAcceptance: 41_330, designerQa: 52_570 } as const;

interface Result { calls: number; instructions: number; input: number; toolDefs: number; images: number; checkpoints: number; reads: number; writes: number; checks: number; agents: number; status: string; redundant: number; failures: number }

/** Characters of inline images (data URLs) in one request's input, wherever they sit. */
function imageChars(v: unknown): number {
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + imageChars(x), 0);
  if (!v || typeof v !== "object") return 0;
  const o = v as Record<string, unknown>;
  if (o.type === "input_image" && typeof o.image_url === "string") return o.image_url.length;
  return Object.values(o).reduce<number>((n, x) => n + imageChars(x), 0);
}

/** Run one scenario and measure the requests the engine made for it. */
async function measure(name: string, files: Record<string, string>, template: string, goal: string, s: Script, budget?: Record<string, unknown>): Promise<Result> {
  dir = path.join(process.env.TEST_BASE_DIR!, `b${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir);
  for (const [p, c] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), c); }
  ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
  reg.setSetting("approval_mode", "auto");
  script = s;
  const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: template, name: "Octopus" });
  const before = model.requests.length;
  const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal, budget });
  const done = await until(run.id, ["completed", "incomplete", "failed"]);
  const reqs = model.requests.slice(before) as { instructions: string; input: unknown; tools?: unknown[] }[];
  const usage = (done.state as { usage?: { file_reads?: number; file_writes?: number; verifications?: number; redundant_reads?: number; agent_runs?: number; tool_failures?: number } }).usage ?? {};
  const result: Result = {
    calls: reqs.length,
    instructions: reqs.reduce((n, r) => n + r.instructions.length, 0),
    input: reqs.reduce((n, r) => n + JSON.stringify(r.input).length, 0),
    toolDefs: reqs.reduce((n, r) => n + JSON.stringify(r.tools ?? []).length, 0),
    images: reqs.reduce((n, r) => n + imageChars(r.input), 0),
    checkpoints: reqs.filter((r) => isCheckpoint(r as { input: unknown[] })).length,
    reads: usage.file_reads ?? 0, writes: usage.file_writes ?? 0, checks: usage.verifications ?? 0,
    redundant: usage.redundant_reads ?? 0, agents: usage.agent_runs ?? 0, status: done.status, failures: usage.tool_failures ?? 0,
  };
  console.log(`bench ${name.padEnd(26)} calls=${result.calls} instr=${result.instructions} input=${result.input} tool_def_chars=${result.toolDefs} image_chars=${result.images} checkpoints=${result.checkpoints} reads=${result.reads} redundant=${result.redundant} writes=${result.writes} checks=${result.checks} turns=${result.agents} failures=${result.failures} status=${result.status}`);
  if (done.status !== "completed") {
    const tasks = await call<{ key: string; kind: string; title: string; status: string; result: string }[]>("GET", `${W()}/runs/${run.id}/tasks`);
    console.log(`  ${name}: ${done.halt_reason ?? "no reason"} | ${tasks.map((t) => `${t.key} ${t.kind}=${t.status}${t.result ? ` (${t.result.replace(/\s+/g, " ").slice(0, 120)})` : ""}`).join(" ; ")}`);
  }
  return result;
}

/** The stock one-file build, as in the audit. */
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

/** Respond to review findings only on a task that actually carries them. */
const answers = (input: unknown) => {
  const s = JSON.stringify(input);
  if (!/Open findings/.test(s)) return undefined;
  return [...new Set(s.match(/F\d+/g) ?? [])].map((id) => ({ id, status: "fixed" as const, response: "Done as asked." }));
};

/** A small page with one review round that requests a change, and one acceptance failure. */
const revisionScript = (withSpecialists: boolean): Script => {
  let reviews = 0, accepts = 0;
  return (b) => {
    const kind = turnKind(b);
    const n = outputs(b).length;
    const ids = [...new Set(JSON.stringify(b.input).match(/\bR\d+\b/g) ?? [])];
    if (kind === "plan") {
      if (!withSpecialists) return n === 0
        ? { calls: [
          { name: "set_requirements", args: { items: ["A landing page with a hero section and a pricing table"] } },
          { name: "create_task", args: { title: "Build the landing page", description: "Create index.html with a hero and a pricing table.", acceptance_criteria: "- hero section", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["index.html"] } }] }
        : { calls: [{ name: "start_work", args: { note: "Lena builds the page." } }] };
      if (n === 0) return { calls: [
        { name: "hire_agent", args: { role_key: "designer", title: "UI/UX Designer", department: "Product & Design", reason: "Judges the look" } },
        { name: "hire_agent", args: { role_key: "qa", title: "QA Engineer", department: "Quality & Ops", reason: "Checks the page" } }] };
      if (n === 2) return { calls: [
        { name: "set_requirements", args: { items: ["A landing page with a hero section and a pricing table"] } },
        { name: "create_task", args: { title: "Build the landing page", description: "Create index.html with a hero and a pricing table.", acceptance_criteria: "- hero section", assignee: "Lena", kind: "build", requirements: ["R1"], files: ["index.html"], specialists: ["Iris", "Sam"] } }] };
      return { calls: [{ name: "start_work", args: { note: "The team builds the page." } }] };
    }
    if (kind === "work") return n === 0
      ? { calls: [{ name: "write_file", args: { path: "index.html", content: "<h1>Acme</h1>\n<table></table>\n", note: "Page" } }] }
      : { calls: [{ name: "complete_task", args: { summary: "Built index.html.", verification: "Opened it", ...(answers(b.input) ? { responses: answers(b.input) } : {}) } }] };
    if (kind === "review") { reviews++; return reviews === 1
      ? { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "The pricing table is empty.", findings: [{ severity: "major", problem: "The pricing table has no rows", evidence: "Read index.html", fix: "Add three plan rows" }] } }] }
      : { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Fixed." } }] }; }
    if (kind === "acceptance") { accepts++; return { calls: [{ name: "submit_acceptance", args: { results: ids.map((id) => accepts === 1
      ? { id, met: false, evidence: "The pricing table is empty in the browser" }
      : { id, met: true, evidence: "Saw three plan rows" }) } }] }; }
    return { text: "The landing page is in index.html." };
  };
};

describe("execution benchmark", () => {
  test("the ceilings are measured below the pre-change baseline in every scenario", () => {
    for (const key of Object.keys(MEASURED) as (keyof typeof MEASURED)[]) expect(MEASURED[key], key).toBeLessThanOrEqual(BASELINE[key]);
  });

  test("a question needs one model call and no agents beyond the lead", async () => {
    const r = await measure("question", {}, "small_dev_team", "What does this project do?",
      (b) => (turnKind(b) === "plan" ? { calls: [{ name: "reply_to_user", args: { message: "A Vite + Fastify app." } }] } : { text: "A Vite + Fastify app." }));
    expect(r.calls).toBe(1);
    expect(r.status).toBe("completed");
  }, 60_000);

  test("a one-file change with no requirements is one plan and one builder turn: no review, no report call", async () => {
    const r = await measure("one-file page", {}, "adaptive", "Build a landing page", buildScript);
    expect(r.calls).toBeLessThanOrEqual(MEASURED.oneFile);
    expect(r.instructions).toBeLessThanOrEqual(INSTRUCTIONS.oneFile);
    expect(r.failures).toBe(0);
    expect(r.agents).toBe(2); // the lead's plan and the builder's turn; a review would add a third
    expect(r.writes).toBe(1);
    expect(r.redundant).toBe(0);
    expect(r.checks).toBe(0);
    expect(r.status).toBe("completed");
  }, 60_000);

  test("a small page with a review round and a failed acceptance stays within its measured calls", async () => {
    const r = await measure("review + acceptance", {}, "small_dev_team", "Build a landing page", revisionScript(false));
    expect(r.calls).toBeLessThanOrEqual(MEASURED.reviewAcceptance);
    expect(r.instructions).toBeLessThanOrEqual(INSTRUCTIONS.reviewAcceptance);
    expect(r.redundant).toBe(0);
    expect(r.status).toBe("completed");
  }, 90_000);

  test("design + QA specialists add their lens, not a second copy of the task", async () => {
    const r = await measure("+ designer & QA", {}, "small_dev_team", "Build a landing page", revisionScript(true));
    expect(r.calls).toBeLessThanOrEqual(MEASURED.designerQa);
    expect(r.instructions).toBeLessThanOrEqual(INSTRUCTIONS.designerQa);
    expect(r.redundant).toBe(0);
    expect(r.status).toBe("completed");
  }, 90_000);

  test("a follow-up continues the lead's transcript and the builder does not re-read a file it holds", async () => {
    const s: Script = (b) => {
      const kind = turnKind(b);
      const n = outputs(b).length;
      if (kind === "plan") return n === 0
        ? { calls: [{ name: "create_task", args: { title: "Make the hero bigger", description: "Increase the hero heading size.", acceptance_criteria: "- h1 is larger", assignee: "Lena", kind: "build", files: ["index.html"] } }] }
        : { calls: [{ name: "start_work", args: { note: "Lena updates the hero." } }] };
      if (kind === "work") return n === 0
        ? { calls: [{ name: "read_file", args: { path: "index.html" } }] }
        : n === 1 ? { calls: [{ name: "edit_file", args: { path: "index.html", old_string: "<h1>Acme</h1>", new_string: "<h1 style=\"font-size:4rem\">Acme</h1>" } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Bigger hero.", verification: "Read it back" } }] };
      if (kind === "review") return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Fine." } }] };
      return { text: "Done." };
    };
    dir = path.join(process.env.TEST_BASE_DIR!, `b${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir);
    ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
    reg.setSetting("approval_mode", "auto");
    // The first run creates index.html, so the follow-up has a file it must read before it edits it.
    script = (b) => (turnKind(b) === "plan" && outputs(b).length === 0
      ? { calls: [{ name: "create_task", args: { title: "Build the landing page", description: "Write index.html.", acceptance_criteria: "- exists", assignee: "Lena", kind: "build", files: ["index.html"] } }] }
      : buildScript(b));
    const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "small_dev_team", name: "Octopus" });
    const run = await call<RunDetail>("POST", `${W()}/runs`, { company_id: team.company.id, goal: "Build the landing page", budget: { review: false } });
    await until(run.id, ["completed", "incomplete", "failed"]);
    const beforeFollowUp = model.requests.length;
    script = s;
    await call("POST", `${W()}/runs/${run.id}/continue`, { content: "Make the hero bigger" });
    const done = await until(run.id, ["completed", "incomplete", "failed"]);
    const followUp = model.requests.slice(beforeFollowUp) as { instructions: string; input: unknown[] }[];
    const usage = (done.state as { usage?: { file_reads?: number; file_writes?: number; agent_runs?: number; redundant_reads?: number; tool_failures?: number } }).usage ?? {};
    console.log(`bench ${"follow-up".padEnd(26)} calls=${followUp.length} tool_def_chars=${followUp.reduce((n, r) => n + JSON.stringify((r as { tools?: unknown[] }).tools ?? []).length, 0)} image_chars=${followUp.reduce((n, r) => n + imageChars(r.input), 0)} checkpoints=${followUp.filter((r) => isCheckpoint(r as { input: unknown[] })).length} reads=${usage.file_reads ?? 0} redundant=${usage.redundant_reads ?? 0} writes=${usage.file_writes ?? 0} turns=${usage.agent_runs ?? 0} status=${done.status}`);
    expect(followUp.length).toBeLessThanOrEqual(MEASURED.followUp);
    // The edit really happened: the file the follow-up changed holds the new markup.
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toContain("font-size:4rem");
    expect(usage.tool_failures ?? 0).toBe(0);
    // The builder reads index.html once, in this turn; it does not read it again after editing it.
    expect(usage.redundant_reads ?? 0).toBe(0);
    expect(usage.file_reads ?? 0).toBeLessThanOrEqual(1);
    // The lead's follow-up planning turn carries its earlier transcript: the last planning request before it is a prefix of it.
    const lastPlanBefore = model.requests.slice(0, beforeFollowUp).findLast((r: { instructions: string }) => turnKind(r) === "plan") as { input: unknown[] };
    const firstFollowPlan = followUp.find((r) => turnKind(r as { instructions: string }) === "plan")!;
    expect(JSON.stringify(firstFollowPlan.input.slice(0, lastPlanBefore.input.length))).toBe(JSON.stringify(lastPlanBefore.input));
    expect(done.status).toBe("completed");
  }, 90_000);

  test("a tool that keeps failing ends the turn in a few calls", async () => {
    const r = await measure("persistent failure", {}, "adaptive", "Build a landing page",
      (b) => (turnKind(b) === "plan"
        ? { calls: [{ name: "create_task", args: { title: "Do the thing", description: "Nothing can own this task.", acceptance_criteria: "- done", assignee: "Octopus", kind: "build" } }] }
        : buildScript(b)));
    expect(r.calls).toBeLessThanOrEqual(MEASURED.persistentFailure);
    expect(r.status).toBe("incomplete");
  }, 60_000);

  test("a cycle that only touches documents runs no project checks", async () => {
    const s: Script = (b) => {
      const kind = turnKind(b);
      const n = outputs(b).length;
      if (kind === "plan") return n === 0
        ? { calls: [{ name: "hire_agent", args: { role_key: "frontend", title: "Frontend Developer", department: "Engineering", reason: "Writes the documentation" } }] }
        : n === 1 ? { calls: [{ name: "create_task", args: { title: "Write the README", description: "Document the project in README.md.", acceptance_criteria: "- README exists", assignee: "Lena", kind: "build", files: ["README.md"] } }] }
                    : { calls: [{ name: "start_work", args: { note: "Lena writes the README." } }] };
        if (kind === "work") return n === 0
        ? { calls: [{ name: "write_file", args: { path: "README.md", content: "# Project\n\nDocs.\n" } }] }
        : { calls: [{ name: "complete_task", args: { summary: "Wrote the README.", verification: "Read it" } }] };
      if (kind === "review") return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Clear." } }] };
      return { text: "Documented." };
    };
    const r = await measure("docs-only change", {
      "package.json": JSON.stringify({ name: "x", scripts: { test: "node should-not-run.js" } }),
      "should-not-run.js": "require('fs').writeFileSync('CHECK_RAN', '1'); process.exit(1);",
    }, "adaptive", "Document the project", s);
    expect(r.calls).toBeLessThanOrEqual(MEASURED.docsOnly);
    expect(r.checks).toBe(0);
    expect(existsSync(path.join(dir, "CHECK_RAN"))).toBe(false);
    expect(r.status).toBe("completed");
  }, 60_000);

  test("five failing reads in one step end the turn as incomplete", async () => {
    const scenario = scriptFor(loadScenario("parallel-miss.json"));
    const r = await measure("parallel-miss", {}, "adaptive", "Read the five config files", scenario.script);
    expect(scenario.stats.unmatched).toBe(0);
    expect(r.failures).toBe(5);
    expect(r.status).toBe("incomplete");
  }, 60_000);

  test("six screenshots fit the window, so no checkpoint call runs", async () => {
    const shots = await screenshotServer();
    reg.mcp.upsert({ id: "mcp-shots", name: "shots", transport: "http", command: "", args: [], url: shots.url, env_enc: "", enabled: true, tools: [], last_error: "", updated_at: new Date().toISOString() });
    const frontend = effectiveRoles(reg).find((x) => x.key === "frontend")!;
    const { source, ...data } = frontend;
    reg.roles.upsert({ key: "frontend", data: { ...data, tools: { ...data.tools, mcp_servers: ["shots"] } }, deleted: false, updated_at: new Date().toISOString() });
    try {
      const scenario = scriptFor(loadScenario("screenshots.json"));
      const r = await measure("screenshots", {}, "adaptive", "Check the page after each change", scenario.script);
      expect(scenario.stats.unmatched).toBe(0);
      expect(r.images).toBeGreaterThan(5 * 60_903);
      // P1 made one checkpoint call here. Each image counts as a fixed token cost, so the window is not reached.
      expect(r.checkpoints).toBe(0);
      expect(r.status).toBe("completed");
    } finally {
      reg.roles.remove("frontend");
      reg.mcp.remove("mcp-shots");
      await shots.close();
    }
  }, 60_000);
});

/** A stand-in MCP server whose one tool returns a 60,903-character screenshot, as an image data URL. */
async function screenshotServer(): Promise<{ url: string; close(): Promise<void> }> {
  // A JPEG data URL prefix is 23 characters, so 60,880 base64 characters make a 60,903-character image URL.
  const data = "A".repeat(60_903 - "data:image/jpeg;base64,".length);
  const http: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const mcp = new McpServer({ name: "shots", version: "1.0.0" });
    mcp.registerTool("take_screenshot", { description: "Take a screenshot of the page.", inputSchema: {} }, async () => ({ content: [{ type: "image" as const, data, mimeType: "image/jpeg" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((resolve) => { http.closeAllConnections(); http.close(() => resolve()); }) };
}



