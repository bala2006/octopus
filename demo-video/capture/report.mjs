// Drives the real Octopus UI and records it. Starts the Octopus server itself (same process tree),
// records CDP screencast frames per window, and logs milestones to marks.json.
// Usage: node capture/run.mjs <outDir>
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] ?? "capture/tour");
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
  const wid = readFileSync("capture/out/wid.txt", "utf8").trim();
  const A = await newPage();
  await A.setViewportSize({ width: 1440, height: 3000 });
  await A.goto(`${BASE}/w/${wid}/agent`);
  await A.waitForTimeout(2500);
  const chatTab = A.getByRole("tab", { name: "Chat", exact: true });
  if (await chatTab.count()) await chatTab.first().click(); else await A.mouse.click(360, 58);
  await A.waitForTimeout(2500);
  const badge = A.getByText("Final report", { exact: true }).last();
  await badge.scrollIntoViewIfNeeded();
  await A.waitForTimeout(1000);
  // the report card: nearest ancestor that also contains "Still open"
  const card = A.locator("div").filter({ has: A.getByText("Final report", { exact: true }) }).filter({ hasText: "Still open" }).last();
  await card.screenshot({ path: path.join(OUT, "shots", "report-card.png") });
  log("ok");
} catch (e) { log("ERROR", e.stack); }
finally { await browser.close().catch(() => {}); server.kill("SIGTERM"); process.exit(0); }
