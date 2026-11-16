/**
 * The solo path's checks-first floor and verifier, end to end through the HTTP API with a scripted model. The project checks
 * are real commands in a temporary project; the model is a script, so no network or real model is used.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasOut, MessageOut, RunDetail, WorkspaceOut } from "@octopus/shared";
import { openRegistry, type Registry } from "../src/db/registry";
import { Conversation } from "../src/engine/conversation";
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
  ["You are the verifier on a coding team", "verifier"],
];

const BLOCK_PREFIX = "The project's checks fail after your change.";
const ACCEPTANCE_PREFIX = "Acceptance check, round";
const approve: Reply = { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks right.", findings: [] } }] };
/** A verifier submission with one entry per ask. */
const verdict = (asks: { id?: string; ask: string; met: boolean; evidence: string }[]): Reply => ({ calls: [{ name: "submit_acceptance", args: { asks } }] });
/** A verifier that finds the one ask met. */
const met = verdict([{ ask: "Add the report module", met: true, evidence: "Reloaded the page and saw the report." }]);
const writeFile = (rel: string, content: string): Reply => ({ calls: [{ name: "write_file", args: { path: rel, content } }] });

let app: FastifyInstance;
let reg: Registry;
let model: FakeModel;
let script: Script = () => ({ text: "ok" });
let ws: WorkspaceOut;
let companyId = "";
let dir = "";
/** How many model requests the tests before the current one made, so a test reads only its own. */
let mark = 0;

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
const send = (runId: string, content: string) => call("POST", `${W()}/runs/${runId}/continue`, { content });
/** The live conversation of the company's latest run, for sending a message while a turn runs. */
function liveConversation(): Conversation {
  const p = project(reg, ws.id);
  return Conversation.get(p, reg, p.db.runs.find("company_id = ?", [companyId], "created_at").at(-1)!.id);
}

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
const verifierRequests = () => requests().slice(mark).filter((b) => who(b) === "verifier");

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
  mark = requests().length;
});

describe("checks before the specialists", () => {
  test("a failing check goes back to the main agent before any specialist runs, and the fix is checked and reviewed", async () => {
    writeProject({ test: "node check.mjs" });
    writeFileSync(path.join(dir, "check.mjs"), CHECK);
    const before = requests().length;
    script = (b) => {
      if (who(b) === "verifier") return met;
      if (who(b)) return approve;
      if (lastUser(b).startsWith(BLOCK_PREFIX)) return outputs(b).length === 0 ? writeFile("fixed.flag", "yes") : { text: "Fixed the check failure." };
      return outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." };
    };
    const id = await start("Add the report module");
    const done = await settle(id);
    expect(done.status).toBe("completed");
    const turn = requests().slice(before);
    const blockAt = turn.findIndex((b) => lastUser(b).startsWith(BLOCK_PREFIX));
    expect(blockAt).toBeGreaterThan(0);
    const firstSpecialist = turn.findIndex((b) => who(b) !== null);
    expect(firstSpecialist).toBeGreaterThan(blockAt);
    const block = lastUser(turn[blockAt]!);
    expect(block.length).toBeLessThanOrEqual(6_000);
    expect(block).toContain("### test (`npm run test`) failed");
    expect(block).toContain("expected 2 got 1");
  }, 120_000);

  test("three failing-check messages at most: the fourth reply goes out incomplete, and no specialist spends a token", async () => {
    writeProject({ test: "node check.mjs" });
    writeFileSync(path.join(dir, "check.mjs"), CHECK);
    const before = requests().length;
    script = (b) => (outputs(b).length === 0 && !lastUser(b).startsWith(BLOCK_PREFIX) ? writeFile("src/report.ts", lines(100)) : { text: "Done." });
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
    script = (b) => (who(b) === "verifier" ? met : who(b) ? approve : outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." });
    const id = await start("Add the report module");
    expect((await settle(id)).status).toBe("completed");
    const ran = readFileSync(path.join(dir, "ran.log"), "utf8").trim().split("\n").sort();
    expect(ran).toEqual(["root-lint", "root-test", "root-typecheck", "web-lint", "web-test", "web-typecheck"]);
    expect(events(id, "tool_call").filter((e) => e.tool === "run_code")).toHaveLength(6);
    const announced = (await messagesOf(id)).filter((m) => m.type === "status_update").map((m) => m.content);
    expect(announced.some((m) => m.includes("Left out: none."))).toBe(true);
  }, 180_000);

  test("a documents-only change runs no check and no verifier", async () => {
    writeProject({ test: "node mark.mjs root-test" });
    writeFileSync(path.join(dir, "mark.mjs"), "import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('./ran.log', import.meta.url), 'ran\\n');\n");
    script = (b) => (who(b) ? approve : outputs(b).length === 0 ? writeFile("README.md", lines(100)) : { text: "Documented." });
    const id = await start("Document the module");
    expect((await settle(id)).status).toBe("completed");
    expect(() => readFileSync(path.join(dir, "ran.log"))).toThrow();
    expect(verifierRequests()).toHaveLength(0);
    const announced = (await messagesOf(id)).filter((m) => m.type === "status_update");
    expect(announced).toHaveLength(0);
  }, 120_000);
});

describe("the verifier", () => {
  test("the verifier runs after the reviewer, and its toolbox has no write tool", async () => {
    const before = requests().length;
    script = (b) => (who(b) === "verifier" ? met : who(b) ? approve : outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." });
    expect((await settle(await start("Add the report module"))).status).toBe("completed");
    const turn = requests().slice(before);
    const reviewer = turn.findIndex((b) => who(b) === "reviewer");
    const verifier = turn.findIndex((b) => who(b) === "verifier");
    expect(reviewer).toBeGreaterThan(-1);
    expect(verifier).toBeGreaterThan(reviewer);
    const names = turn[verifier]!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "glob", "grep", "shell", "start_dev_server", "submit_acceptance"]));
    for (const forbidden of ["write_file", "edit_file", "delete_file", "submit_review", "ask_user", "remember"]) expect(names).not.toContain(forbidden);
  }, 120_000);

  test("asks come from every message of the request, and a later request's asks come from its own message", async () => {
    const before = requests().length;
    script = (b) => {
      if (who(b) === "verifier") return met;
      if (who(b)) return approve;
      if (lastUser(b) === "Add the report module" && outputs(b).length === 0) {
        // A message sent mid-turn joins the request before the next step.
        liveConversation().submit("Also make the title red.", [], null);
        return writeFile("src/report.ts", lines(100));
      }
      if (lastUser(b).startsWith("Now the footer") && outputs(b).length === 0) return writeFile("src/footer.ts", lines(100));
      return { text: "Done." };
    };
    const id = await start("Add the report module");
    expect((await settle(id)).status).toBe("completed");
    const first = verifierRequests()[0]!;
    expect(lastUser(first)).toContain("Add the report module");
    expect(lastUser(first)).toContain("Also make the title red.");
    await send(id, "Now the footer only");
    const end = Date.now() + 60_000;
    while (verifierRequests().length < 2 && Date.now() < end) await sleep(25);
    expect((await settle(id)).status).toBe("completed");
    expect(requests().length).toBeGreaterThan(before);
    const second = verifierRequests()[1]!;
    expect(lastUser(second)).toContain("Now the footer only");
    expect(lastUser(second)).not.toContain("Add the report module");
  }, 120_000);

  test("an ask still unmet after the second round stops the run as incomplete", async () => {
    const before = requests().length;
    script = (b) => {
      if (who(b) === "verifier") return lastUser(b).includes("Verify round 2") ? verdict([{ id: "R1", ask: "Add the report module", met: false, evidence: "The page still shows Acme." }]) : verdict([{ ask: "Add the report module", met: false, evidence: "The page still shows Acme." }]);
      if (who(b)) return approve;
      if (lastUser(b).startsWith(ACCEPTANCE_PREFIX)) return outputs(b).length === 0 ? writeFile(`src/fix${requests().length}.ts`, lines(100)) : { text: "Changed the page." };
      return outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." };
    };
    const done = await settle(await start("Add the report module"));
    expect(done.status).toBe("incomplete");
    expect(done.halt_reason).toBe("Two acceptance checks left R1 not met.");
    const verifying = requests().slice(before).filter((b) => who(b) === "verifier");
    expect(verifying).toHaveLength(2);
    expect(lastUser(verifying[1]!)).toContain("R1 [not met] Add the report module");
  }, 120_000);

  test("an ask met in the second round is met, the run completes, and the requirements list shows it", async () => {
    script = (b) => {
      if (who(b) === "verifier") return lastUser(b).includes("Verify round 2") ? verdict([{ id: "R1", ask: "Add the report module", met: true, evidence: "Reloaded the page and saw the report." }]) : verdict([{ ask: "Add the report module", met: false, evidence: "The page still shows Acme." }]);
      if (who(b)) return approve;
      if (lastUser(b).startsWith(ACCEPTANCE_PREFIX)) return outputs(b).length === 0 ? writeFile("src/report-fix.ts", lines(100)) : { text: "Changed the page." };
      return outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." };
    };
    const id = await start("Add the report module");
    const done = await settle(id);
    expect(done.status).toBe("completed");
    const shown = events(id, "requirements_updated").at(-1)!.requirements as { id: string; status: string; note: string }[];
    expect(shown).toEqual([expect.objectContaining({ id: "R1", status: "met", note: "Reloaded the page and saw the report." })]);
  }, 120_000);

  test("an ask the verifier cannot observe is unmet, its evidence says what is needed, and the run is incomplete", async () => {
    script = (b) => {
      if (who(b) === "verifier") return verdict([{ ask: "Add the report module", met: false, evidence: "The check needs a dev server, and the project has no start script. Add one to check it." }]);
      if (who(b)) return approve;
      if (lastUser(b).startsWith(ACCEPTANCE_PREFIX)) return { text: "I cannot start a dev server from here." };
      return outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." };
    };
    const id = await start("Add the report module");
    const done = await settle(id);
    expect(done.status).toBe("incomplete");
    expect(done.halt_reason).toBe("Not met: R1.");
    expect(requests().some((b) => lastUser(b).includes("R1 not met: Add the report module") && lastUser(b).includes("Add one to check it."))).toBe(true);
    const shown = events(id, "requirements_updated").at(-1)!.requirements as { id: string; status: string }[];
    expect(shown).toEqual([expect.objectContaining({ id: "R1", status: "unmet" })]);
  }, 120_000);

  test("a verifier that submits no asks never completes the run", async () => {
    const before = requests().length;
    script = (b) => {
      if (who(b) === "verifier") return { text: "Looks fine to me." };
      if (who(b)) return approve;
      return outputs(b).length === 0 ? writeFile("src/report.ts", lines(100)) : { text: "Wrote the report." };
    };
    const done = await settle(await start("Add the report module"));
    expect(done.status).toBe("incomplete");
    expect(done.halt_reason).toBe("Two acceptance checks did not submit their asks.");
    expect(requests().slice(before).filter((b) => who(b) === "verifier")).toHaveLength(2);
  }, 120_000);

  test("review with verifier runs the verifier once, and the floor does not run it again for the same change", async () => {
    const before = requests().length;
    script = (b) => {
      if (who(b) === "verifier") return met;
      if (who(b)) return approve;
      const n = outputs(b).length;
      if (lastUser(b).startsWith("Add the report module") && n === 0) return writeFile("src/report.ts", lines(100));
      if (lastUser(b).startsWith("Add the report module") && n === 1) return { calls: [{ name: "review", args: { specialists: ["verifier"], focus: "Wrote the report module." } }] };
      return { text: "Reviewed and done." };
    };
    const id = await start("Add the report module");
    expect((await settle(id)).status).toBe("completed");
    expect(verifierRequests()).toHaveLength(1);
    expect(requests().slice(before).some((b) => JSON.stringify(b.input).includes(`${ACCEPTANCE_PREFIX} 1: 1 of 1 asks met.`))).toBe(true);
  }, 120_000);

  test("review with verifier while checks fail runs no verifier", async () => {
    writeProject({ test: "node check.mjs" });
    writeFileSync(path.join(dir, "check.mjs"), CHECK);
    script = (b) => {
      if (who(b)) return who(b) === "verifier" ? met : approve;
      const n = outputs(b).length;
      if (lastUser(b).startsWith(BLOCK_PREFIX) || n >= 2) return { text: "Done." };
      if (n === 0) return writeFile("src/report.ts", lines(100));
      return { calls: [{ name: "review", args: { specialists: ["verifier"], focus: "Wrote the report module." } }] };
    };
    const done = await settle(await start("Add the report module"));
    expect(done.status).toBe("incomplete");
    expect(verifierRequests()).toHaveLength(0);
    expect(requests().some((b) => JSON.stringify(b.input).includes("The project's checks fail, so the acceptance check did not run."))).toBe(true);
  }, 120_000);
});

describe("the check cap", () => {
  test("a project with more than eight checks runs the first eight and names the rest", () => {
    const scripts = { test: "node a.js", typecheck: "node a.js", lint: "node a.js" };
    writeProject(scripts, { a: scripts, b: scripts, c: scripts });
    const { run, left } = verificationChecks(new ProjectFs(dir));
    expect(run).toHaveLength(8);
    expect(left.map((c) => c.name)).toEqual(["lint", "a: lint", "b: lint", "c: lint"]);
  });
});
