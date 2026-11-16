/** The read-only specialists: the check-only shell, the project snapshot that undoes what a check changed, and their toolboxes. Real commands run in temporary folders. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { SPECIALIST_NAMES } from "@octopus/shared";
import type { CanvasOut, MessageOut, RunDetail, WorkspaceOut } from "@octopus/shared";
import { effectiveRoles } from "../src/catalog/roles";
import { openRegistry, type Registry } from "../src/db/registry";
import { buildServer } from "../src/http/server";
import { encrypt } from "../src/lib/secrets";
import { project as openWorkspace } from "../src/workspace/projects";
import { fakeModel, outputs, type FakeModel, type Reply, type Script } from "./fakeModel";
import { checkShellTool } from "../src/tools/commands";
import { specialistToolbox } from "../src/tools";
import { RETURN_LIMIT, SPECIALIST_DEFS, specialistDefaults } from "../src/engine/specialists";
import { tierOf, reviewersFor } from "../src/engine/risk";
import { briefDiff } from "../src/lib/diff";
import { reviewReport } from "../src/lib/findings";
import { ProjectFs } from "../src/safety/paths";
import { checkOnly } from "../src/safety/commands";
import { enterRound, leaveRound, restoreSnapshot, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_TOTAL, takeSnapshot } from "../src/workspace/snapshot";
import type { ToolContext } from "../src/tools/types";

const win = process.platform === "win32";
const [program, ...probeArgs] = win ? ["pwsh", "-NoProfile", "-Command", "exit 0"] : ["bash", "-c", "exit 0"];
const missing = spawnSync(program!, probeArgs, { encoding: "utf8" }).status !== 0;
if (missing) console.warn(`shell tests skipped: ${program} is not installed`);
const shellTest = missing ? test.skip : test;

/** A temporary project with the given files. Nothing here touches the repository. */
function project(files: Record<string, string> = {}): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(path.join(tmpdir(), "specialists-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  const ctx = {
    agent: { id: "specialist-1" }, task: null, runId: "run", fs: new ProjectFs(root), signal: new AbortController().signal,
    db: {}, seen: new Map(), shown: new Map(), answering: null, setStatus() {}, emit() {}, recordFile() {},
    ownerOf: () => null, guard: async () => { throw new Error("A check-only command never asks for approval"); },
  } as unknown as ToolContext;
  return { root, ctx };
}

const runCheck = (ctx: ToolContext, command: string) => checkShellTool.run(ctx, checkShellTool.args.parse({ command }), "call-1");

describe("check-only policy", () => {
  test.each([
    ["npx prettier --write .", "write-flag"],
    ["npm test -- -u", "write-flag"],
    ["echo x > a.txt", "redirect"],
    ["npm install left-pad", "install"],
    ["git commit -m done", "git-change"],
    ["node -e \"require('fs').writeFileSync('a', '')\"", "inline-code"],
    ["curl -o out.html https://example.com", "write-flag"],
    ["npm run deploy", "not-allowed"],
  ])("refuses %s and names rule %s", (command, rule) => {
    const verdict = checkOnly(command, process.cwd());
    expect(verdict).toMatchObject({ allowed: false, rule });
  });

  test.each(["npm test", "npm run typecheck", "git status", "git diff --stat", "node check.mjs", "curl https://example.com", "npm test 2>&1 | Select-Object -Last 5"])(
    "allows %s", (command) => {
      expect(checkOnly(command, process.cwd())).toEqual({ allowed: true });
    });
});

describe("check-only shell", () => {
  shellTest("a refused command never runs, and the result names the rule", async () => {
    const { root, ctx } = project({ "src.txt": "kept" });
    const res = await runCheck(ctx, "echo x > a.txt");
    expect(res.ok).toBe(false);
    expect(res.text).toContain("rule redirect");
    expect(existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  shellTest("git status and npm test run for real in the project", async () => {
    const { root, ctx } = project({
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "node check.mjs" } }),
      "check.mjs": "console.log('checks passed');\n",
    });
    spawnSync("git", ["init", "-q"], { cwd: root });
    const status = await runCheck(ctx, "git status --short");
    expect(status.ok).toBe(true);
    expect(status.text.endsWith("[exit code: 0]")).toBe(true);
    const tests = await runCheck(ctx, "npm test");
    expect(tests.ok).toBe(true);
    expect(tests.text).toContain("checks passed");
    expect(tests.text.endsWith("[exit code: 0]")).toBe(true);
  }, 60_000);
});

describe("project snapshot", () => {
  shellTest("a check that rewrites a file and adds one is undone", async () => {
    const { root, ctx } = project({
      "src.txt": "before",
      "change.mjs": "import { writeFileSync } from 'node:fs';\nwriteFileSync('src.txt', 'after');\nwriteFileSync('new.txt', 'made by the check');\n",
    });
    const snap = takeSnapshot(root)!;
    const res = await runCheck(ctx, "node change.mjs");
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(root, "src.txt"), "utf8")).toBe("after");
    const report = restoreSnapshot(root, snap);
    expect(report.restored).toEqual(["src.txt"]);
    expect(report.deleted).toEqual(["new.txt"]);
    expect(readFileSync(path.join(root, "src.txt"), "utf8")).toBe("before");
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  test("files over 1 MB and ignored folders are not recorded", () => {
    const { root } = project({ "small.txt": "a", "big.bin": "x".repeat(SNAPSHOT_MAX_BYTES + 1), "node_modules/pkg/index.js": "module" });
    const snap = takeSnapshot(root)!;
    expect([...snap.files.keys()]).toEqual(["small.txt"]);
    expect(snap.partial).toBe(false);
  });

  test("a folder with more files than the record holds never has new files deleted", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= SNAPSHOT_MAX_FILES; i++) files[`f${i}.txt`] = "x";
    const { root } = project(files);
    const snap = takeSnapshot(root)!;
    expect(snap.partial).toBe(true);
    expect(snap.files.size).toBe(SNAPSHOT_MAX_FILES);
    writeFileSync(path.join(root, "extra.txt"), "made later");
    const report = restoreSnapshot(root, snap);
    expect(report.deleted).toEqual([]);
    expect(existsSync(path.join(root, "extra.txt"))).toBe(true);
  }, 60_000);

  test("a project over the 64 MB total has no undo record", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 70; i++) files[`blob${i}.bin`] = "x".repeat(SNAPSHOT_MAX_BYTES - 1);
    const { root } = project(files);
    expect(SNAPSHOT_MAX_TOTAL).toBe(64 * 1024 * 1024);
    expect(takeSnapshot(root)).toBeNull();
    expect(await enterRound(root, {})).toEqual({ undoable: false });
    expect(leaveRound(root, {})).toBeNull();
  }, 60_000);

  test("rounds of one owner share one record, and the last one to end restores", async () => {
    const { root } = project({ "a.txt": "original" });
    const owner = {};
    await enterRound(root, owner);
    await enterRound(root, owner);
    writeFileSync(path.join(root, "a.txt"), "changed");
    expect(leaveRound(root, owner)).toBeNull();
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("changed");
    const report = leaveRound(root, owner);
    expect(report?.restored).toEqual(["a.txt"]);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
  });

  test("a round of another owner waits until the first owner's rounds end, so the two never interleave", async () => {
    const { root } = project({ "a.txt": "original" });
    const first = {};
    const second = {};
    await enterRound(root, first);
    writeFileSync(path.join(root, "a.txt"), "changed by the first round");
    let entered = false;
    const waiting = enterRound(root, second).then(() => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    expect(leaveRound(root, first)?.restored).toEqual(["a.txt"]);
    await waiting;
    expect(entered).toBe(true);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
    writeFileSync(path.join(root, "a.txt"), "changed by the second round");
    expect(leaveRound(root, second)?.restored).toEqual(["a.txt"]);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
  });
});

/** Tools that change state, remember things or ask the user. No specialist may hold one. */
const WRITE_TOOLS = ["write_file", "edit_file", "move_file", "delete_file", "remember", "forget", "ask_user", "todo_write", "message", "reply", "pin", "complete_task", "block_task", "start_work", "hire_agent"];

describe("specialist definitions", () => {
  test.each(SPECIALIST_NAMES)("%s has its prompt and skill, under 4,000 characters together", (name) => {
    const def = SPECIALIST_DEFS[name];
    expect(def.instructions.length).toBeLessThan(4_000);
    expect(def.instructions).toContain("\n\n");
    expect(def.instructions.startsWith(readFileSync(path.join(process.cwd(), "src", "catalog", "specialists", name, "prompt.md"), "utf8").trim())).toBe(true);
  });

  test("each specialist has the effort the plan sets", () => {
    expect(Object.fromEntries(SPECIALIST_NAMES.map((n) => [n, SPECIALIST_DEFS[n].effort]))).toEqual({ reviewer: "medium", security: "high", designer: "high", explorer: "low", verifier: "high" });
  });

  test("the explorer ends with a plain text answer, and no prompt names a tool its toolbox lacks", () => {
    expect(SPECIALIST_DEFS.explorer.ends).toBe("answer");
    expect(SPECIALIST_DEFS.explorer.tools).not.toContain("submit_review");
    const outside = ["fetch_url", "start_dev_server", "submit_review", "write_file", "edit_file", "delete_file", "ask_user", "todo_write", "remember"];
    for (const name of SPECIALIST_NAMES) {
      const def = SPECIALIST_DEFS[name];
      for (const tool of outside) {
        if ((def.tools as readonly string[]).includes(tool)) continue;
        expect(new RegExp(`\\b${tool}\\b`).test(def.instructions), `${name} names ${tool}`).toBe(false);
      }
    }
  });
});

describe("specialist toolboxes", () => {
  test.each(SPECIALIST_NAMES)("%s gets its listed tools, the check-only shell, and no write tool", async (name) => {
    const { root } = project();
    const { tools } = await specialistToolbox(SPECIALIST_DEFS[name].tools, root);
    const names = tools.map((t) => t.name);
    for (const forbidden of WRITE_TOOLS) expect(names).not.toContain(forbidden);
    expect(names).toEqual(expect.arrayContaining(["read_file", "glob", "grep", "shell"]));
    expect(tools.find((t) => t.name === "shell")).toBe(checkShellTool);
  });

  test("the reviewer, security and designer end with submit_review, and the explorer has none", async () => {
    const { root } = project();
    const named = async (name: (typeof SPECIALIST_NAMES)[number]) => (await specialistToolbox(SPECIALIST_DEFS[name].tools, root)).tools.map((t) => t.name);
    expect(await named("reviewer")).toContain("submit_review");
    expect(await named("security")).toEqual(expect.arrayContaining(["submit_review", "fetch_url"]));
    expect(await named("designer")).toEqual(expect.arrayContaining(["submit_review", "start_dev_server"]));
    expect(await named("explorer")).not.toContain("submit_review");
    expect(await named("reviewer")).not.toContain("fetch_url");
  });

  test("the designer's browser is missing when the browser is off, and the toolbox says why", async () => {
    const { root } = project();
    const { tools, warnings } = await specialistToolbox(SPECIALIST_DEFS.designer.tools, root);
    expect(tools.some((t) => t.name.startsWith("browser_"))).toBe(false);
    expect(warnings.some((w) => w.startsWith("Browser unavailable"))).toBe(true);
  });
});

/** Specialist types the scripted model can tell apart by the prompt each one runs with. */
const SPECIALIST_PROMPTS: [string, string][] = [
  ["You are the reviewer on a coding team", "reviewer"],
  ["You are the security reviewer on a coding team", "security"],
  ["You are the designer on a coding team", "designer"],
  ["You answer one question for Octopus", "explorer"],
  ["You are the verifier on a coding team", "verifier"],
];

interface Request { instructions: string; input: any[]; tools: { name: string }[]; model: string; reasoning?: { effort: string } } // eslint-disable-line @typescript-eslint/no-explicit-any

/** A file of `count` numbered lines, so a write changes about that many lines. */
const lines = (count: number, tag = "line") => `${Array.from({ length: count }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n")}\n`;

describe("review and explore from a solo conversation", () => {
  let app: FastifyInstance;
  let reg: Registry;
  let model: FakeModel;
  let script: Script = () => ({ text: "ok" });
  let ws: WorkspaceOut;
  let companyId = "";
  let dir = "";

  const call = async <T>(method: string, url: string, payload?: unknown): Promise<T> => {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { host: "127.0.0.1" } });
    if (res.statusCode >= 400) throw new Error(`${method} ${url}  ${res.statusCode}: ${res.body}`);
    return res.json() as T;
  };
  const W = () => `/api/v1/w/${ws.id}`;
  const requests = () => model.requests as unknown as Request[];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** The specialist a request runs for, or null for the main agent. */
  const who = (b: Request) => SPECIALIST_PROMPTS.find(([text]) => b.instructions.includes(text))?.[1] ?? null;
  const lastUser = (b: Request) => String([...b.input].reverse().find((i) => i.role === "user" && typeof i.content === "string")?.content ?? "");
  const startsWith = (later: Request, earlier: Request) => JSON.stringify(later.input.slice(0, earlier.input.length)) === JSON.stringify(earlier.input);
  const settle = async (runId: string): Promise<RunDetail> => {
    const end = Date.now() + 60_000;
    for (;;) {
      const r = await call<RunDetail>("GET", `${W()}/runs/${runId}`);
      if (["completed", "awaiting_user", "incomplete", "failed", "cancelled"].includes(r.status)) return r;
      if (Date.now() > end) throw new Error(`run stayed ${r.status}`);
      await sleep(25);
    }
  };
  const start = async (goal: string) => (await call<RunDetail>("POST", `${W()}/runs`, { company_id: companyId, goal })).id;
  /** The events of one type a run wrote to its project log. */
  const events = (runId: string, type: string) => openWorkspace(reg, ws.id).db.events.find("run_id = ? AND type = ?", [runId, type], "seq").map((e) => e.data as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The output of the last tool call a request holds. */
  const lastOutput = (b: Request) => String(b.input.filter((i) => i.type === "function_call_output").at(-1)?.output ?? "");

  beforeAll(async () => {
    model = await fakeModel((b) => script(b));
    reg = openRegistry(path.join(process.env.TEST_BASE_DIR!, "home", "registry.db"));
    reg.setSetting("provider.azure", { base_url: model.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
    app = await buildServer(reg);
  });
  afterAll(async () => { await app.close(); await model.close(); });

  beforeEach(async () => {
    dir = path.join(process.env.TEST_BASE_DIR!, `r${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "index.html"), "<h1>Acme</h1>\n");
    ws = await call<WorkspaceOut>("POST", "/api/v1/workspaces", { path: dir });
    reg.setSetting("approval_mode", "auto");
    const team = await call<CanvasOut>("POST", `${W()}/companies/from-template`, { template_key: "solo", name: "Octopus" });
    companyId = team.company.id;
  });

  test("a review runs reviewer and security at once, refuses a write, undoes a check's edit, and returns one message", async () => {
    writeFileSync(path.join(dir, "change.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('index.html', 'changed by a check');\n");
    script = (b) => {
      const role = who(b);
      const n = outputs(b).length;
      if (role === "reviewer") {
        if (n === 0) return { calls: [{ name: "shell", args: { command: "npx prettier --write ." } }] };
        if (n === 1) return { calls: [{ name: "shell", args: { command: "node change.mjs" } }] };
        return { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "The heading does not match the request.", findings: [{ severity: "major", file: "index.html", lines: "1", problem: "The heading still says Acme.", evidence: "index.html line 1 reads Acme.", fix: "Change the heading to Globex." }] } }] };
      }
      if (role === "security") return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "No input or secret is involved.", findings: [] } }] };
      if (role) throw new Error(`unexpected specialist ${role}`);
      const asked = lastUser(b).startsWith("Rename the heading");
      return n === 0 && asked ? { calls: [{ name: "review", args: { specialists: ["reviewer", "security"], focus: "Changed the heading in index.html to Globex." } }] } : { text: "Reviewed the change." };
    };
    const before = requests().length;
    const id = await start("Rename the heading to Globex");
    const done = await settle(id);
    // The main agent never answers the major finding, so every fix round finds it still open.
    expect(done.status).toBe("incomplete");
    expect(done.halt_reason).toBe("Two review rounds ended with 1 blocker or major finding open.");
    const fresh = requests().slice(before);
    const reviewer = fresh.filter((b) => who(b) === "reviewer");
    expect(reviewer).toHaveLength(9);
    const names = reviewer[0]!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read_file", "glob", "grep", "shell", "submit_review"]));
    for (const forbidden of WRITE_TOOLS) expect(names).not.toContain(forbidden);
    expect(JSON.stringify(reviewer[1]!.input)).toContain("Refused by the check-only policy (rule write-flag)");
    expect(readFileSync(path.join(dir, "index.html"), "utf8")).toBe("<h1>Acme</h1>\n");
    const warnings = events(id, "error").filter((e) => e.kind === "warning").map((e) => String(e.message));
    expect(warnings.find((m) => m.includes("reviewer ran"))).toContain("`node change.mjs`");
    expect(warnings.find((m) => m.includes("reviewer ran"))).not.toContain("prettier");
    const message = lastOutput(fresh.filter((b) => !who(b)).at(-1)!);
    expect(message).toContain("Review of your change, round 1. reviewer: request changes. security: approve.");
    expect(message).toContain("F1 major index.html:1 (reviewer)");
    expect(message.length).toBeLessThan(6_000);
    const agents = openWorkspace(reg, ws.id).db.agents.find("company_id = ?", [companyId]);
    const lead = agents.find((a) => a.is_entry)!;
    for (const key of ["specialist-reviewer", "specialist-security"]) {
      const agent = agents.find((a) => a.behavior.template_key === key);
      expect(agent?.reports_to).toBe(lead.id);
    }
    expect(effectiveRoles(reg).some((r) => r.key.startsWith("specialist-"))).toBe(false);
    expect(events(id, "agent_created").length).toBe(5);
    expect(events(id, "agent_status").some((e) => agents.some((a) => a.id === e.agent_id && a.behavior.template_key === "specialist-reviewer"))).toBe(true);
    expect(events(id, "edge_activity").length).toBeGreaterThanOrEqual(4);
  });

  test("a second review continues the reviewer's first session and numbers the round", async () => {
    script = (b) => {
      const role = who(b);
      if (role === "reviewer") return { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks right.", findings: [] } }] };
      if (role) throw new Error(`unexpected specialist ${role}`);
      const n = outputs(b).length;
      if (n === 0) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "First look at the heading." } }] };
      if (n === 1) return { calls: [{ name: "write_file", args: { path: "second.txt", content: "A second file.\n" } }] };
      if (n === 2) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "Second look after the new file." } }] };
      return { text: "Reviewed twice." };
    };
    const before = requests().length;
    const done = await settle(await start("Check the heading"));
    expect(done.status).toBe("completed");
    const fresh = requests().slice(before);
    const reviewer = fresh.filter((b) => who(b) === "reviewer");
    expect(reviewer).toHaveLength(2);
    expect(startsWith(reviewer[1]!, reviewer[0]!)).toBe(true);
    expect(reviewer[1]!.input.length).toBeGreaterThan(reviewer[0]!.input.length);
    expect(lastOutput(fresh.filter((b) => !who(b)).at(-1)!)).toContain("round 2");
  });

  test("a manual review with no code change since the last round returns its blockers and starts no reviewer", async () => {
    const verdicts: Reply[] = [
      { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "The heading is wrong.", findings: [{ severity: "major", file: "index.html", lines: "1", problem: "The heading still says Acme.", evidence: "index.html line 1 reads Acme.", fix: "Change the heading to Globex." }] } }] },
      { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "The heading is right now.", findings: [] } }] },
    ];
    script = (b) => {
      const role = who(b);
      if (role === "reviewer") {
        const next = verdicts.shift();
        if (!next) throw new Error("a reviewer ran although the code had no change");
        return next;
      }
      if (role) throw new Error(`unexpected specialist ${role}`);
      const n = outputs(b).length;
      if (n === 0) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "First look at the heading." } }] };
      if (n === 1) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "Looked again with no change." } }] };
      if (n === 2) return { calls: [{ name: "write_file", args: { path: "globe.txt", content: "Globex\n" } }] };
      if (n === 3) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "Added globe.txt after the review." } }] };
      return { text: "Reviewed after the change." };
    };
    const before = requests().length;
    const done = await settle(await start("Make the heading say Globex"));
    expect(done.status).toBe("completed");
    const fresh = requests().slice(before);
    expect(fresh.filter((b) => who(b) === "reviewer")).toHaveLength(2);
    const outs = fresh.filter((b) => !who(b)).at(-1)!.input.filter((i) => i.type === "function_call_output").map((i) => String(i.output));
    expect(outs[1]).toContain("A review already ran for this code and reported these blockers or major findings:");
    expect(outs[1]).toContain("F1 major index.html:1 (reviewer): The heading still says Acme.");
    expect(outs[3]).toContain("Review of your change, round 2. reviewer: approve.");
  });

  test("an explore answer returns under 6,000 characters", async () => {
    script = (b) => {
      const role = who(b);
      if (role === "explorer") return { text: "A".repeat(12_000) };
      if (role) throw new Error(`unexpected specialist ${role}`);
      return outputs(b).length === 0 ? { calls: [{ name: "explore", args: { question: "How is the heading built? Q1" } }] } : { text: "Explored." };
    };
    const before = requests().length;
    const done = await settle(await start("Find the heading"));
    expect(done.status).toBe("completed");
    const answer = lastOutput(requests().slice(before).filter((b) => !who(b)).at(-1)!);
    expect(answer.length).toBeGreaterThan(5_000);
    expect(answer.length).toBeLessThan(6_000);
  });

  test("explore calls in one step run together and return in call order", async () => {
    script = (b) => {
      const role = who(b);
      if (role === "explorer") {
        return { text: `Answer ${/Q\d/.exec(lastUser(b))?.[0]}` };
      }
      if (role) throw new Error(`unexpected specialist ${role}`);
      return outputs(b).length === 0
        ? { calls: [{ name: "explore", args: { question: "Where is the heading? Q1" } }, { name: "explore", args: { question: "Which file holds the menu? Q2" } }, { name: "explore", args: { question: "What runs the tests? Q3" } }] }
        : { text: "Explored three." };
    };
    const before = requests().length;
    const done = await settle(await start("Answer three questions"));
    expect(done.status).toBe("completed");
    const explorer = requests().slice(before).find((b) => who(b) === "explorer")!;
    expect(explorer.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["fetch_url", "read_file"]));
    expect(explorer.tools.map((t) => t.name)).not.toContain("submit_review");
    const outs = requests().slice(before).filter((b) => !who(b)).at(-1)!.input.filter((i) => i.type === "function_call_output").map((i) => i.output);
    expect(outs).toEqual(["Answer Q1", "Answer Q2", "Answer Q3"]);
  });

  describe("review floor", () => {
    const approve: Reply = { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Looks right.", findings: [] } }] };
    /** The verifier finds the one ask met. */
    const verified: Reply = { calls: [{ name: "submit_acceptance", args: { asks: [{ ask: "Add the report module", met: true, evidence: "Ran the page and saw the report." }] } }] };
    /** A main agent that writes `write` once, then replies. A review message gets `answer`. */
    const mainTurn = (write: { path: string; content: string } | null, reply: string, answer = "Checked it again. It stays.") => (b: Request): Reply => {
      if (lastUser(b).startsWith("Review of your change")) return { text: answer };
      if (write && outputs(b).length === 0) return { calls: [{ name: "write_file", args: write }] };
      return { text: reply };
    };
    /** One request in which the main agent writes a file and the specialists answer with `specialist`. */
    const runWrite = async (rel: string, content: string, specialist: (b: Request) => Reply = () => approve) => {
      const before = requests().length;
      script = (b) => (who(b) === "verifier" ? verified : who(b) ? specialist(b) : mainTurn({ path: rel, content }, "Wrote it.")(b));
      const id = await start(`Add ${rel}`);
      const done = await settle(id);
      const fresh = requests().slice(before);
      const roles = fresh.map((b) => who(b)).filter((r): r is string => r !== null);
      return { id, status: done.status, fresh, roles };
    };

    /** The settings Settings would hold: every specialist on, with `changes` applied over them. */
    const withSettings = (changes: Record<string, { enabled: boolean; model: string; effort: string }>) => {
      const base = specialistDefaults();
      return { ...base, specialists: { ...base.specialists, ...changes } };
    };
    afterEach(() => reg.deleteSetting("specialists"));

    test("a specialist turned off in Settings does not run, and the floor skips it", async () => {
      reg.setSetting("specialists", withSettings({ security: { enabled: false, model: "gpt-6-luna", effort: "high" }, verifier: { enabled: false, model: "gpt-6-luna", effort: "high" } }));
      const high = await runWrite("src/auth/login.ts", "export const ok = true;\n");
      expect(high.roles).toEqual(["reviewer"]);
      expect(high.status).toBe("completed");
    });

    test("each specialist's requests name the model and effort Settings holds", async () => {
      reg.setSetting("specialists", withSettings({ reviewer: { enabled: true, model: "gpt-6-mini", effort: "low" } }));
      const normal = await runWrite("src/report.ts", lines(100));
      const reviewer = normal.fresh.filter((b) => who(b) === "reviewer");
      expect(reviewer.length).toBeGreaterThan(0);
      for (const b of reviewer) {
        expect(b.model).toBe("gpt-6-mini");
        expect(b.reasoning?.effort).toBe("low");
      }
      const verifier = normal.fresh.filter((b) => who(b) === "verifier");
      expect(verifier.every((b) => b.model === "gpt-6-luna")).toBe(true);
    });
    test("a new solo conversation seats one agent per specialist that Settings turns on", async () => {
      reg.setSetting("specialists", withSettings({ security: { enabled: false, model: "gpt-6-luna", effort: "high" } }));
      script = () => ({ text: "Hello." });
      const done = await settle(await start("Say hello"));
      expect(done.status).toBe("completed");
      const keys = openWorkspace(reg, ws.id).db.agents.find("company_id = ?", [companyId]).map((a) => a.behavior.template_key).filter((k) => k?.startsWith("specialist-")).sort();
      expect(keys).toEqual(["specialist-designer", "specialist-explorer", "specialist-reviewer", "specialist-verifier"]);
    });
    test("the floor runs the reviewer at normal and high, and runs nothing at trivial or small", async () => {
      const normal = await runWrite("src/report.ts", lines(100));
      expect(normal.roles).toEqual(["reviewer", "verifier"]);
      const high = await runWrite("src/auth/login.ts", "export const ok = true;\n");
      expect(high.roles.sort()).toEqual(["reviewer", "security", "verifier"]);
      const trivial = await runWrite("src/one.ts", "export const one = 1;\n");
      expect(trivial.roles).toEqual([]);
      const small = await runWrite("src/small.ts", lines(25));
      expect(small.roles).toEqual([]);
      expect([normal.status, high.status, trivial.status, small.status]).toEqual(["completed", "completed", "completed", "completed"]);
    });

    test("a review the main agent already ran covers its change, so the floor does not run again", async () => {
      const before = requests().length;
      script = (b) => {
        if (who(b) === "verifier") return verified;
        if (who(b)) return approve;
        const n = outputs(b).length;
        if (n === 0) return { calls: [{ name: "write_file", args: { path: "src/report.ts", content: lines(100) } }] };
        if (n === 1) return { calls: [{ name: "review", args: { specialists: ["reviewer"], focus: "Wrote the report module." } }] };
        return { text: "Reviewed and done." };
      };
      const done = await settle(await start("Add the report module"));
      expect(done.status).toBe("completed");
      expect(requests().slice(before).filter((b) => who(b) === "reviewer")).toHaveLength(1);
    });

    test("two floor rounds at most: the reply goes out incomplete, with the open findings listed", async () => {
      const blocker: Reply = { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "The filter is ignored.", findings: [{ severity: "major", file: "src/report.ts", lines: "1-100", problem: "The page ignores the filter.", evidence: "report.ts never reads the filter.", fix: "Read the filter in report.ts." }] } }] };
      const before = requests().length;
      script = (b) => (who(b) === "verifier" ? verified : who(b) ? blocker : mainTurn({ path: "src/report.ts", content: lines(100) }, "I kept the module as it is.")(b));
      const id = await start("Add the report module");
      const done = await settle(id);
      expect(done.status).toBe("incomplete");
      expect(done.halt_reason).toBe("Two review rounds ended with 1 blocker or major finding open.");
      const reviewer = requests().slice(before).filter((b) => who(b) === "reviewer");
      expect(reviewer).toHaveLength(2);
      const second = lastUser(reviewer[1]!);
      expect(second).toContain("Review round 2 of this request.");
      expect(second).toContain("F1 [major] src/report.ts:1-100: The page ignores the filter.");
      expect(second).toContain("Checked it again. It stays.");
      const messages = await call<MessageOut[]>("GET", `${W()}/runs/${id}/messages`);
      const report = messages.find((m) => m.type === "final_report")!;
      expect(report.content).toContain("Open items:\n- F2 major src/report.ts:1-100 (reviewer): The page ignores the filter.");
    });

    test("the second floor round continues the reviewer's first session", async () => {
      const blocker: Reply = { calls: [{ name: "submit_review", args: { verdict: "request_changes", comments: "Still wrong.", findings: [{ severity: "major", file: "src/report.ts", lines: "1", problem: "The page is blank.", evidence: "report.ts returns nothing.", fix: "Return the rows." }] } }] };
      const before = requests().length;
      script = (b) => (who(b) === "verifier" ? verified : who(b) ? blocker : mainTurn({ path: "src/report.ts", content: lines(100) }, "Kept it.")(b));
      await settle(await start("Add the report module"));
      const reviewer = requests().slice(before).filter((b) => who(b) === "reviewer");
      expect(reviewer).toHaveLength(2);
      expect(startsWith(reviewer[1]!, reviewer[0]!)).toBe(true);
    });

    test("minor findings are listed in the reply and never sent back to the main agent", async () => {
      const minor: Reply = { calls: [{ name: "submit_review", args: { verdict: "approve", comments: "Fine, with one naming note.", findings: [{ severity: "minor", file: "src/report.ts", lines: "3", problem: "The name could be clearer.", evidence: "line 3 uses x", fix: "rename x" }] } }] };
      const run = await runWrite("src/report.ts", lines(100), () => minor);
      expect(run.status).toBe("completed");
      expect(run.roles).toEqual(["reviewer", "verifier"]);
      const main = run.fresh.filter((b) => !who(b));
      expect(main).toHaveLength(2);
      expect(main.some((b) => lastUser(b).startsWith("Review of your change"))).toBe(false);
      const messages = await call<MessageOut[]>("GET", `${W()}/runs/${run.id}/messages`);
      expect(messages.find((m) => m.type === "final_report")?.content).toContain("Open items:\n- F1 minor src/report.ts:3 (reviewer): The name could be clearer.");
    });

    test("the first brief holds the user's words and the whole diff, and a diff over 60,000 characters is a file list", async () => {
      const short = await runWrite("src/report.ts", lines(100));
      const brief = String(short.fresh.find((b) => who(b) === "reviewer")!.input[0]!.content);
      expect(brief).toContain("The user's messages for this request, verbatim:\nAdd src/report.ts");
      expect(brief).toContain("### src/report.ts (101 changed lines)");
      expect(brief).toContain("+export const line99 = 99;");
      const long = await runWrite("src/big.ts", lines(3_000, "entry"));
      const bigBrief = String(long.fresh.find((b) => who(b) === "reviewer")!.input[0]!.content);
      expect(bigBrief).toMatch(/- src\/big\.ts: 3001 changed lines/);
      expect(bigBrief).not.toContain("+export const entry1 = 1;");
    });

    test("a project over the undo limit runs its round without a record, and warns that its checks are not undone", async () => {
      for (let i = 0; i < 70; i++) writeFileSync(path.join(dir, `blob${i}.bin`), "x".repeat(SNAPSHOT_MAX_BYTES - 1));
      writeFileSync(path.join(dir, "change.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('index.html', 'changed by a check');\n");
      const run = await runWrite("src/report.ts", lines(100), (b) => (outputs(b).length === 0 ? { calls: [{ name: "shell", args: { command: "node change.mjs" } }] } : approve));
      expect(run.status).toBe("completed");
      const warnings = events(run.id, "error").filter((e) => e.kind === "warning").map((e) => String(e.message));
      expect(warnings.some((m) => m.includes("over the 64 MB limit"))).toBe(true);
      expect(readFileSync(path.join(dir, "index.html"), "utf8")).toBe("changed by a check");
    }, 60_000);
  });
});

describe("review floor rules", () => {
  test.each([
    [{ files: ["a.ts"], lines: 2 }, "trivial"],
    [{ files: ["a.ts"], lines: 25 }, "small"],
    [{ files: ["a.ts", "b.ts"], lines: 10 }, "small"],
    [{ files: ["a.ts"], lines: 100 }, "normal"],
    [{ files: ["package.json"], lines: 2 }, "normal"],
    [{ files: ["src/auth/login.ts"], lines: 2 }, "high"],
    [{ files: ["src/a.ts"], lines: 500 }, "high"],
  ])("tierOf %j is %s", (part, tier) => {
    expect(tierOf({ specialists: 0, requirements: 0, revised: false, ...part })).toBe(tier);
  });

  test("the reviewer always runs, security runs on a sensitive path, and the designer on a UI file when the browser is on", () => {
    expect(reviewersFor(["src/report.ts"], false)).toEqual(["reviewer"]);
    expect(reviewersFor(["src/auth/login.ts"], false)).toEqual(["reviewer", "security"]);
    expect(reviewersFor(["src/App.tsx"], true)).toEqual(["reviewer", "designer"]);
    expect(reviewersFor(["src/App.tsx"], false)).toEqual(["reviewer"]);
  });

  test("a diff under 60,000 characters is whole, and a larger one is a list with line counts", () => {
    const small = [{ file: "a.ts", text: "+one", lines: 1 }, { file: "b.ts", text: "+two", lines: 1 }, { file: "c.ts", text: "+none", lines: 0 }];
    expect(briefDiff(small)).toBe("### a.ts (1 changed lines)\n+one\n\n### b.ts (1 changed lines)\n+two");
    const large = [{ file: "a.ts", text: "+x".repeat(40_000), lines: 40_000 }, { file: "b.ts", text: "+y".repeat(30_000), lines: 30_000 }];
    const list = briefDiff(large);
    expect(list).toContain("- a.ts: 40000 changed lines");
    expect(list).toContain("- b.ts: 30000 changed lines");
    expect(list).not.toContain("+x+x");
  });

  test("a review message stays under the return limit and says how many findings it cut", () => {
    const findings = Array.from({ length: 120 }, (_, i) => ({ severity: "major" as const, file: `src/file${i}.ts`, lines: "1-9", problem: "p".repeat(150), evidence: "e".repeat(150), fix: "f".repeat(150) }));
    const message = reviewReport(1, [{ critic: "reviewer", verdict: "request_changes", findings }], RETURN_LIMIT);
    expect(message.length).toBeLessThanOrEqual(6_000);
    expect(message).toMatch(/\d+ more findings did not fit/);
  });

  test("minor findings are listed for the user and never asked to be fixed", () => {
    const message = reviewReport(2, [
      { critic: "security", verdict: "approve", findings: [{ severity: "minor", file: "src/a.ts", lines: "3", problem: "Header could be stricter.", evidence: "line 3", fix: "add a header" }] },
    ], RETURN_LIMIT);
    expect(message.split("\n")[0]).toBe("Review of your change, round 2. security: approve.");
    expect(message).toContain("No blocker or major finding.");
    expect(message).toContain("Minor, not sent back:\nF1 src/a.ts:3 (security) Header could be stricter.");
  });
});
