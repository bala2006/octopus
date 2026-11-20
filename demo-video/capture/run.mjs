// Drives the real Octopus UI and records it. Starts the Octopus server itself (same process tree),
// records CDP screencast frames per window, and logs milestones to marks.json.
// Usage: node capture/run.mjs <outDir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] ?? "capture/out");
const ROOT = "/projects/sandbox/octopus";
const BASE = "http://127.0.0.1:8000";
const PROJECT = "/projects/sandbox/octopus-demo/projects/chai-tapri";
const env = Object.fromEntries(readFileSync("/projects/sandbox/octopus-demo/.env", "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const PROMPT = "Build a landing page for Chai Tapri, a small chai cafe in Bengaluru. It needs a warm hero section, a menu with prices in rupees, an order counter where I can add and remove cups and see the total, and a contact section with opening hours. Make it responsive and keep it plain HTML, CSS and JavaScript.";

mkdirSync(OUT, { recursive: true });
mkdirSync(PROJECT, { recursive: true });
const T0 = Date.now();
const log = (...a) => { const s = `[${((Date.now() - T0) / 1000).toFixed(1)}s] ${a.join(" ")}`; console.log(s); appendFileSync(path.join(OUT, "log.txt"), s + "\n"); };
const marks = [];
const mark = (name, extra = {}) => { marks.push({ name, t: Date.now(), ...extra }); writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks, null, 1)); log("MARK", name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- server ----------
const server = spawn("node", ["scripts/octopus.mjs", "start"], { cwd: ROOT, env: { ...process.env, OCTOPUS_SKIP_BUILD: "true", PLAYWRIGHT_MCP_BROWSER: "chromium", PLAYWRIGHT_MCP_NO_SANDBOX: "true", PLAYWRIGHT_MCP_EXECUTABLE_PATH: "/root/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell" }, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => appendFileSync(path.join(OUT, "server.log"), d));
server.stderr.on("data", (d) => appendFileSync(path.join(OUT, "server.log"), d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch {} await sleep(500); }
log("server up");

// ---------- recorder ----------
async function recorder(page, name) {
  const dir = path.join(OUT, name);
  mkdirSync(path.join(dir, "f"), { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0, on = true;
  cdp.on("Page.screencastFrame", async (e) => {
    try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
    if (!on) return;
    const file = `f/${String(n++).padStart(6, "0")}.jpg`;
    writeFileSync(path.join(dir, file), Buffer.from(e.data, "base64"));
    frames.push([Math.round(e.metadata.timestamp * 1000), file]);
    if (n % 50 === 0) writeFileSync(path.join(dir, "frames.json"), JSON.stringify(frames));
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  return { async stop() { on = false; try { await cdp.send("Page.stopScreencast"); } catch {} writeFileSync(path.join(dir, "frames.json"), JSON.stringify(frames)); } };
}

const browser = await chromium.launch();
const ctxOpts = { viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3, colorScheme: "dark" };
async function newPage() {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(() => {
    localStorage.setItem("octopus-theme", "dark");
    if (!localStorage.getItem("octopus-app")) localStorage.setItem("octopus-app", JSON.stringify({ state: { theme: "dark", onboarded: false, sidebarOpen: true, currency: "INR", companyByWorkspace: {}, chatFilter: "all", profileName: "Bala" }, version: 0 }));
  });
  return ctx.newPage();
}
const shot = async (page, name) => { try { await page.screenshot({ path: path.join(OUT, "shots", `${name}.png`) }); } catch (e) { log("shot fail", name, e.message); } };
mkdirSync(path.join(OUT, "shots"), { recursive: true });

// A visible cursor, since headless pages don't draw one.
const CURSOR = () => {
  if (document.getElementById("__cursor")) return;
  const c = document.createElement("div");
  c.id = "__cursor";
  c.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.22,1,.36,1);";
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.6L20 11z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  window.__moveCursor = (x, y) => { c.style.transform = `translate(${x - 3}px, ${y - 2}px)`; };
  window.__clickPulse = (x, y) => {
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x - 18}px;top:${y - 18}px;width:36px;height:36px;border-radius:50%;border:2px solid #F1D01A;z-index:2147483646;pointer-events:none;transition:all .5s ease-out;opacity:1`;
    document.documentElement.appendChild(r);
    requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
    setTimeout(() => r.remove(), 600);
  };
};
async function ensureCursor(page) { await page.evaluate(`(${CURSOR.toString()})()`).catch(() => {}); }
async function click(page, loc, wait = 450) {
  await loc.waitFor({ state: "visible", timeout: 30000 });
  const b = await loc.boundingBox();
  if (b) {
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.evaluate(([x, y]) => { if (!window.__moveCursor) return; window.__moveCursor(x, y); }, [x, y]);
    await sleep(wait);
    await page.evaluate(([x, y]) => window.__clickPulse && window.__clickPulse(x, y), [x, y]);
  }
  await loc.click();
  await sleep(250);
}
async function type(page, loc, text, delay = 28) { await click(page, loc); await page.keyboard.type(text, { delay }); }

const api = async (p, opts) => { const r = await fetch(BASE + p, { ...opts, headers: { "content-type": "application/json", origin: BASE, ...(opts?.headers ?? {}) } }); return r.json(); };

try {
  // ---------- A: main window ----------
  const A = await newPage();
  await A.goto(BASE + "/");
  await A.waitForTimeout(1500);
  await ensureCursor(A);
  const recA = await recorder(A, "main");
  mark("home");
  await A.waitForTimeout(2000);
  await shot(A, "01-home");

  // Settings -> Model
  const settingsLink = A.locator('a[title="Settings"], a:has-text("Settings")').first();
  if (await settingsLink.count()) await click(A, settingsLink); else await A.goto(BASE + "/settings#providers");
  await A.waitForTimeout(1500);
  await ensureCursor(A);
  mark("settings");
  await shot(A, "02-settings");
  await type(A, A.getByLabel("Azure OpenAI endpoint"), env.AZURE_API_BASE, 12);
  await A.waitForTimeout(400);
  await type(A, A.getByLabel("Azure OpenAI API key"), env.AZURE_API_KEY, 4);
  await A.waitForTimeout(600);
  mark("keys_typed");
  await shot(A, "03-keys");
  await click(A, A.getByRole("button", { name: "Save", exact: true }));
  await A.waitForTimeout(1500);
  mark("saved");
  await click(A, A.getByRole("button", { name: "Test connection" }));
  await A.getByText(/Connected to/).first().waitFor({ timeout: 90000 });
  mark("test_ok");
  await A.waitForTimeout(2500);
  await shot(A, "04-test-ok");

  // Home -> approval mode + prompt
  const home = A.locator('a[title="Home"], a:has-text("Home")').first();
  if (await home.count()) await click(A, home); else await A.goto(BASE + "/");
  await A.waitForTimeout(1500);
  await ensureCursor(A);
  mark("home2");
  try {
    await click(A, A.getByRole("button", { name: /Approval mode/ }));
    await A.waitForTimeout(700);
    await click(A, A.getByRole("menuitem", { name: /Approve for me/ }));
    await A.waitForTimeout(600);
  } catch (e) { log("approval mode picker:", e.message); await api("/api/v1/settings/approval-mode", { method: "PUT", body: JSON.stringify({ approval_mode: "auto" }) }); }
  mark("approval_mode");
  await type(A, A.getByLabel("Describe what you want to build"), PROMPT, 22);
  mark("prompt_typed");
  await A.waitForTimeout(1200);
  await shot(A, "05-prompt");
  await click(A, A.getByRole("button", { name: /Choose a project folder and continue|Continue in selected project/ }));
  await A.waitForTimeout(1200);
  mark("create_dialog");
  await shot(A, "06-dialog");
  await type(A, A.getByLabel("Project name"), "Chai Tapri", 40);
  await click(A, A.getByRole("button", { name: "Add", exact: true }));
  await A.waitForTimeout(1500);
  await shot(A, "07-browse");
  // Manual path entry
  const toggle = A.getByText("Enter a folder path instead");
  if (await toggle.count()) await click(A, toggle.first());
  await A.waitForTimeout(500);
  await type(A, A.getByLabel("Paste a local folder path"), PROJECT, 18);
  await click(A, A.getByRole("button", { name: "Use folder" }));
  await A.waitForTimeout(900);
  await shot(A, "08-folder");
  await click(A, A.getByRole("button", { name: "Create project" }));
  mark("project_created");
  await A.waitForURL(/\/w\/[^/]+\/agent/, { timeout: 60000 });
  const wid = A.url().match(/\/w\/([^/]+)\//)[1];
  log("workspace", wid);
  await ensureCursor(A);
  writeFileSync(path.join(OUT, "wid.txt"), wid);
  await A.waitForTimeout(2500);
  await shot(A, "08b-agent");
  mark("agent_page");
  // The draft moves into the project composer; send it.
  const send = A.getByRole("button", { name: /Send agent message|Send direction to agents|Queue message/ }).first();
  try { await click(A, send, 700); } catch (e) { log("send click", e.message.split("\n")[0]); await A.getByLabel("Message the team lead").first().press("Enter"); }
  mark("sent");

  // wait for run to exist
  let runId = null;
  for (let i = 0; i < 120 && !runId; i++) {
    const runs = await api(`/api/v1/w/${wid}/runs`).catch(() => null);
    const list = Array.isArray(runs) ? runs : runs?.runs ?? runs?.items ?? [];
    if (list.length) runId = list[0].id;
    else await sleep(1000);
  }
  log("run", runId);
  if (!runId) throw new Error("no run started");
  mark("run_started", { runId });
  await shot(A, "09-run-start");

  // ---------- B: canvas window ----------
  const B = await newPage();
  await B.goto(`${BASE}/w/${wid}/agent`);
  await B.waitForTimeout(2500);
  try { const ct = B.getByRole("tab", { name: "Chat", exact: true }); if (await ct.count()) await ct.first().click(); else await B.mouse.click(360, 58); } catch (e) { log("B chat tab", e.message.split("\n")[0]); }
  await B.waitForTimeout(1500);
  const recB = await recorder(B, "canvas");
  mark("canvas_open");
  await shot(B, "10-canvas");

  // ---------- monitor ----------
  let status = "running", k = 0, lastLen = 0;
  const TERMINAL = ["completed", "incomplete", "failed", "cancelled"];
  while (true) {
    await sleep(5000);
    k++;
    const r = await api(`/api/v1/w/${wid}/runs/${runId}`).catch(() => null);
    const s = r?.status ?? r?.run?.status ?? status;
    if (s !== status) { status = s; mark("status_" + s); }
    // approvals: click Approve if a card shows
    for (const P of [A, B]) {
      const ap = P.getByTestId("approve");
      if (await ap.count().catch(() => 0)) { log("approving"); mark("approval"); await click(P, ap.first()).catch(() => {}); }
    }
    if (k % 6 === 1) { try { const { execSync } = await import("node:child_process"); log("MCPENV", execSync("bash /projects/sandbox/octopus-demo/tmp/mcpenv.sh").toString().replace(/\n/g, " | ").slice(0, 600)); } catch {} }
    // keep the chat scrolled to newest
    if (k % 12 === 0) { await shot(A, `run-A-${String(k).padStart(4, "0")}`); await shot(B, `run-B-${String(k).padStart(4, "0")}`); }
    if (TERMINAL.includes(status)) break;
    if (Date.now() - T0 > 55 * 60 * 1000) { log("timeout"); break; }
  }
  mark("run_done", { status });
  await A.waitForTimeout(4000);
  await shot(A, "20-done-chat");
  await shot(B, "20-done-canvas");
  await recB.stop();

  // ---------- tour of the result inside Octopus ----------
  await ensureCursor(A);
  // scroll chat to bottom slowly to show the final report
  await A.mouse.move(1100, 450);
  for (let i = 0; i < 6; i++) { await A.mouse.wheel(0, 400); await sleep(250); }
  await A.waitForTimeout(2500);
  await shot(A, "21-report");
  mark("tour_report");
  for (const tab of ["Review", "Changes", "Usage", "Browser"]) {
    try {
      let t = A.getByRole("tab", { name: tab, exact: true });
      if (!(await t.count())) {
        await click(A, A.getByRole("button", { name: "New tab" }).first());
        await A.waitForTimeout(600);
        t = A.getByRole("button", { name: tab, exact: true }).last();
      }
      await click(A, t.first());
      await A.waitForTimeout(3500);
      mark("tour_" + tab.toLowerCase());
      await shot(A, `22-${tab.toLowerCase()}`);
    } catch (e) { log("tab", tab, e.message.split("\n")[0]); }
  }
  // Changes space
  try { await A.goto(`${BASE}/w/${wid}/artifacts`); await A.waitForTimeout(2500); await ensureCursor(A); mark("tour_artifacts"); await shot(A, "23-artifacts"); } catch {}
  try { await A.goto(`${BASE}/w/${wid}/runs`); await A.waitForTimeout(2500); await ensureCursor(A); mark("tour_history"); await shot(A, "24-history"); } catch {}
  await recA.stop();

  // ---------- D: the actual output ----------
  if (existsSync(path.join(PROJECT, "index.html"))) {
    const D = await newPage();
    await D.goto("file://" + path.join(PROJECT, "index.html"));
    await D.waitForTimeout(1500);
    await ensureCursor(D);
    const recD = await recorder(D, "site");
    mark("site");
    await D.waitForTimeout(2000);
    await shot(D, "30-site-hero");
    for (let i = 0; i < 10; i++) { await D.mouse.wheel(0, 260); await sleep(450); }
    await shot(D, "31-site-mid");
    // try the order counter
    const plus = D.locator('button:has-text("+"), button[aria-label*="Add" i], button[aria-label*="increase" i]');
    const nPlus = await plus.count();
    log("plus buttons", nPlus);
    if (nPlus) {
      await plus.first().scrollIntoViewIfNeeded();
      await D.waitForTimeout(800);
      for (let i = 0; i < 3; i++) await click(D, plus.first(), 250);
      if (nPlus > 1) for (let i = 0; i < 2; i++) await click(D, plus.nth(1), 250);
      await D.waitForTimeout(1500);
      await shot(D, "32-site-order");
      mark("site_order");
    }
    for (let i = 0; i < 10; i++) { await D.mouse.wheel(0, 300); await sleep(400); }
    await D.waitForTimeout(1500);
    await shot(D, "33-site-bottom");
    await recD.stop();
    // mobile view
    const M = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })).newPage();
    await M.goto("file://" + path.join(PROJECT, "index.html"));
    await M.waitForTimeout(1500);
    await M.screenshot({ path: path.join(OUT, "shots", "34-mobile.png") });
    await M.screenshot({ path: path.join(OUT, "shots", "35-mobile-full.png"), fullPage: true });
    await D.screenshot({ path: path.join(OUT, "shots", "36-site-full.png"), fullPage: true });
  } else log("no index.html in project");
  mark("end");
} catch (e) {
  log("ERROR", e.stack);
} finally {
  await browser.close().catch(() => {});
  server.kill("SIGTERM");
  log("finished");
  process.exit(0);
}
