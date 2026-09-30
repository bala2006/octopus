// Records the ~60 s product demo of the REAL Octopus app (Demo Mode) with captions and a visible cursor.
//
//   cd frontend && npm run build && npx playwright install chromium
//   OUT=/tmp/octopus-video node ../scripts/demo-video/record.mjs
//   ffmpeg -i $OUT/raw/*.webm -ss 0.4 -t 61 -vf "fps=30,scale=1920:1080:flags=lanczos,fade=t=in:st=0:d=0.5,fade=t=out:st=60.2:d=0.8,format=yuv420p" \
//          -c:v libx264 -preset slow -crf 20 -movflags +faststart ../docs/media/octopus-demo.mp4
//
// It starts its own backend on an isolated OCTOPUS_HOME, so your projects aren't touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(`${R}/frontend/package.json`)("playwright");
const OUT = process.env.OUT ?? path.join(R, ".demo-video");
const root = `${OUT}/data`;
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(`${OUT}/raw`, { recursive: true, force: true });
fs.mkdirSync(`${root}/projects/todo-app`, { recursive: true });
const PORT = 8871, B = `http://127.0.0.1:${PORT}`;
const W = 1440, H = 810;

const srv = spawn(`${R}/backend/.venv/bin/python`, ["-m", "uvicorn", "app.main:app", "--port", String(PORT)], {
  cwd: `${R}/backend`,
  env: { ...process.env, OCTOPUS_HOME: `${root}/home`, WORKSPACE_ALLOWED_ROOTS: JSON.stringify([`${root}/projects`]), DEMO_MODE: "true",
    LOG_LEVEL: "WARNING", MOCK_STREAM_DELAY: process.env.DELAY ?? "0.006", BROWSER_ENABLED: "false", NATIVE_DIALOGS: "false" },
  stdio: ["ignore", "ignore", "inherit"],
});
const j = (r) => r.json();
const post = (u, b) => fetch(`${B}${u}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then(j);
const logo = fs.readFileSync(`${R}/frontend/public/octopus.svg`, "utf8");
const font = fs.readFileSync(`${R}/frontend/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`).toString("base64");

// overlay: caption bar + cursor + click ripple, survives SPA navigation
const OVERLAY = `(() => {
  const css = \`
  #oc-cap{position:fixed;left:50%;bottom:34px;transform:translate(-50%,20px);opacity:0;z-index:2147483647;pointer-events:none;
    font-family:Inter,'Inter Variable',system-ui,sans-serif;text-align:center;transition:opacity .45s, transform .45s cubic-bezier(.2,.8,.2,1)}
  #oc-cap.on{opacity:1;transform:translate(-50%,0)}
  #oc-cap .t{display:inline-block;background:rgba(20,20,19,.92);color:#F5F4EE;font-size:30px;font-weight:700;letter-spacing:-.5px;
    padding:14px 26px;border-radius:18px;box-shadow:0 18px 50px -12px rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.08)}
  #oc-cap .t b{color:#E08A6B}
  #oc-cap .s{margin-top:8px;font-size:17px;color:#E9E8E5;text-shadow:0 1px 8px rgba(0,0,0,.9)}
  #oc-cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(640px,360px);transition:transform .05s linear}
  #oc-cur svg{filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}
  .oc-rip{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #D97756;z-index:2147483646;pointer-events:none;
    animation:oc-r .55s ease-out forwards}
  @keyframes oc-r{from{transform:scale(.2);opacity:1}to{transform:scale(1.4);opacity:0}}
  #oc-badge{position:fixed;right:14px;top:58px;z-index:2147483647;pointer-events:none;font:600 12px Inter,system-ui,sans-serif;color:#BDBBB2;
    background:rgba(20,20,19,.75);border:1px solid rgba(255,255,255,.08);padding:5px 10px;border-radius:999px}\`;
  const add = () => {
    if (document.getElementById('oc-cur')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement('div'); cap.id = 'oc-cap'; document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = 'oc-cur';
    cur.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.7 L11.6 14 L18 14 Z" fill="#F5F4EE" stroke="#141413" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(cur);
    addEventListener('mousemove', (e) => { cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; }, true);
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = 'oc-rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.body.appendChild(r); setTimeout(() => r.remove(), 600); }, true);
    window.__cap = (t, s) => { cap.classList.remove('on'); setTimeout(() => { cap.innerHTML = t ? '<div class="t">' + t + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') : ''; if (t) cap.classList.add('on'); }, t ? 180 : 0); };
    window.__badge = (t) => { let b = document.getElementById('oc-badge'); if (!b) { b = document.createElement('div'); b.id = 'oc-badge'; document.body.appendChild(b); } b.textContent = t; b.style.display = t ? '' : 'none'; };
    const hide = document.createElement('style'); hide.textContent = '[data-sonner-toaster]{display:none!important}'; document.head.appendChild(hide);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();`;

const card = (inner, bg = "#1F1E1D") => `<!doctype html><html><head><style>
  @font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format("woff2");font-weight:100 900}
  html,body{margin:0;height:100%;background:${bg};font-family:Inter;color:#F5F4EE;overflow:hidden}
  .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
  .logo{width:230px;height:230px;animation:pop 1s cubic-bezier(.2,1.4,.3,1) both}
  .logo svg{width:100%;height:100%}
  @keyframes pop{from{transform:scale(.3) rotate(-12deg);opacity:0}to{transform:none;opacity:1}}
  @keyframes up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
  @keyframes draw{from{stroke-dashoffset:520}to{stroke-dashoffset:0}}
  @keyframes wig{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
  h1{margin:0;font-size:92px;letter-spacing:-4px;font-weight:780;animation:up .7s .35s both}
  .u path{stroke-dasharray:520;animation:draw .9s .7s both}
  p{margin:0;font-size:32px;color:#E9E8E5;animation:up .7s .9s both}
  p b{color:#E08A6B;font-weight:650}
  .row{display:flex;gap:14px;margin-top:26px;animation:up .7s 1.3s both}
  .pill{font-size:19px;padding:10px 18px;border-radius:999px;background:#2C2C2C;border:1px solid #444442;color:#E9E8E5}
  .pill i{font-style:normal;color:#A9BF7E}
  .wig{animation:pop 1s cubic-bezier(.2,1.4,.3,1) both, wig 2.2s 1s ease-in-out infinite}
  code{font-family:ui-monospace,monospace;font-size:22px;color:#E9E8E5;background:#2C2C2C;border:1px solid #444442;padding:10px 16px;border-radius:12px;animation:up .7s 1.1s both}
</style></head><body><div class="c">${inner}</div></body></html>`;

async function smoothMove(page, x, y, ms = 650) {
  const steps = Math.max(8, Math.round(ms / 16));
  await page.mouse.move(x, y, { steps });
}
async function clickOn(page, locator, { dx = 0.5, dy = 0.5, pause = 250, ms } = {}) {
  await locator.waitFor({ state: "visible", timeout: 20000 });
  const bb = await locator.boundingBox();
  await smoothMove(page, bb.x + bb.width * dx, bb.y + bb.height * dy, ms);
  await page.waitForTimeout(pause);
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
}
const cap = (page, t, s) => page.evaluate(([a, b]) => window.__cap?.(a, b), [t, s]);
const badge = (page, t) => page.evaluate((a) => window.__badge?.(a), t);
async function type(page, text, delay = 38) { for (const ch of text) { await page.keyboard.type(ch); await page.waitForTimeout(delay); } }

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${B}/api/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  // Seed: one project with a finished run, so its files exist for the preview scene
  const ws = await post("/api/v1/workspaces", { path: `${root}/projects/todo-app`, default_permission: "danger" });
  fs.mkdirSync(`${root}/projects/snake-game`, { recursive: true });
  await post("/api/v1/workspaces", { path: `${root}/projects/snake-game` });
  fs.mkdirSync(`${root}/projects/landing-page`, { recursive: true });
  await post("/api/v1/workspaces", { path: `${root}/projects/landing-page` });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: "dark",
    recordVideo: { dir: `${OUT}/raw`, size: { width: W, height: H } } });
  await ctx.addInitScript(() => localStorage.setItem("octopus-app", JSON.stringify({ state: { theme: "dark", companyByWorkspace: {}, chatFilter: "all", onboarded: true }, version: 0 })));
  await ctx.addInitScript(OVERLAY);
  const page = await ctx.newPage();
  const t0 = Date.now();
  const mark = (n) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s  ${n}`);

  // ---- 1. Intro (0-5s)
  await page.setContent(card(`<div class="logo">${logo}</div>
     <h1>Octopus</h1><svg class="u" width="440" height="16" viewBox="0 0 440 16"><path d="M4 9 C 130 15, 300 13, 436 4" stroke="#D97756" stroke-width="7" stroke-linecap="round" fill="none"/></svg>
     <p>Your <b>AI company</b>, in one folder.</p>
     <div style="margin-top:22px;font-size:15px;color:#8A8780;animation:up .7s 1.2s both">Real app footage · Demo Mode (offline scripted agents)</div>`));
  mark("intro"); await page.waitForTimeout(3600);

  // ---- 2. Welcome / projects (5-10s)
  await page.goto(`${B}/`); await page.waitForTimeout(700);
  await cap(page, "Pick any <b>folder</b> on your laptop", "Octopus manages its own .octopus/ inside it, like .git");
  mark("welcome");
  await smoothMove(page, 560, 292, 800); await page.waitForTimeout(900);
  await clickOn(page, page.getByRole("link", { name: /Open/ }).last().or(page.getByRole("button", { name: /^Open$/ })).first(), { ms: 800 });
  await page.waitForURL(/\/canvas/);

  // ---- 3. Templates → company (10-19s)
  await cap(page, "Start from <b>14 team templates</b>", "Software startup, game studio, SaaS launch, security audit…");
  mark("templates");
  await clickOn(page, page.getByTestId("new-company"), { ms: 700 });
  await page.waitForTimeout(600);
  const dlg = page.getByRole("dialog");
  for (const name of [/Indie Game Studio/, /Software Startup/]) {
    const opt = dlg.getByRole("radio", { name }).first();
    if (await opt.count()) { await opt.scrollIntoViewIfNeeded(); await clickOn(page, opt, { ms: 500, pause: 350 }); }
  }
  await page.waitForTimeout(500);
  await clickOn(page, page.getByTestId("create-company"), { ms: 600 });
  await page.locator(".react-flow__node").first().waitFor();
  await page.waitForTimeout(900);

  // ---- 4. Canvas + agent config (19-27s)
  await cap(page, "Your org chart: <b>departments</b>, managers, typed channels", "Delegate ↓ · Report ↑ · Review · Debate · Consult");
  mark("canvas");
  await smoothMove(page, 760, 300, 800); await page.waitForTimeout(1300);
  await clickOn(page, page.getByTestId("agent-node-Marcus"), { dy: 0.3, ms: 700 });
  await cap(page, "Tune every agent", "Role, prompt, tools, a real browser, gpt-6-luna and its reasoning effort");
  await page.waitForTimeout(900);
  const quick = page.getByRole("dialog", { name: "Configure Marcus" });
  const eff = quick.getByRole("radio", { name: "Effort High" });
  if (await eff.count()) { await eff.scrollIntoViewIfNeeded(); await clickOn(page, eff, { ms: 600, pause: 300 }); }
  await page.waitForTimeout(900);
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);

  // ---- 5. Run live (27-44s)
  await cap(page, "Give the company a <b>goal</b>", "");
  mark("run dialog");
  await clickOn(page, page.getByTestId("run-company"), { ms: 700 });
  await page.getByTestId("run-goal").click();
  await type(page, "Build a todo app with login", 32);
  await page.waitForTimeout(250);
  await clickOn(page, page.getByRole("radio", { name: /Danger/ }), { ms: 500, pause: 200 });
  await clickOn(page, page.getByTestId("start-run"), { ms: 500 });
  await page.waitForURL(/\/runs\//);
  await cap(page, "Watch them <b>plan, debate, code and review</b>", "Live: who's thinking, messages on every channel, files as they're written");
  mark("live run");
  await page.waitForTimeout(2400);
  const n = page.locator(".react-flow__node").nth(2);
  if (await n.count()) {
    const bb = await n.boundingBox();
    await smoothMove(page, bb.x + bb.width / 2, bb.y + 16, 600); await page.mouse.down();
    await smoothMove(page, bb.x + bb.width / 2 - 70, bb.y + 60, 700); await page.mouse.up();
  }
  await page.waitForTimeout(2000);
  await cap(page, "You stay in control", "Permission levels, approvals, pause, interject, replay");
  await page.waitForTimeout(2200);
  await cap(page, "Exact <b>tokens & cost</b> from Azure", "Input · cached · cache writes · output, at gpt-6-luna prices");
  await clickOn(page, page.getByRole("button", { name: "Token and cost details" }), { ms: 700 });
  await page.waitForTimeout(2400);
  await page.keyboard.press("Escape");
  const runId = page.url().split("/runs/")[1];
  for (let i = 0; i < 90; i++) {
    const r = await (await fetch(`${B}/api/v1/w/${ws.id}/runs/${runId}`)).json();
    if (fs.existsSync(`${root}/projects/todo-app/frontend/index.html`) && ["completed", "failed", "cancelled"].includes(r.status)) break;
    await page.waitForTimeout(500);
  }
  mark("continue");
  await cap(page, "Runs are <b>conversations</b>", "Ask for a change: same team, same files, full context");
  await clickOn(page, page.getByLabel("Interjection"), { ms: 600 });
  await type(page, "Add a dark mode toggle", 34);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);

  // ---- 6. Artifacts + preview
  mark("artifacts");
  await clickOn(page, page.getByRole("link", { name: "Artifacts" }).first(), { ms: 700 });
  await cap(page, "<b>Real files</b> in your folder, every version diffed", "");
  await page.waitForTimeout(700);
  await clickOn(page, page.getByRole("treeitem", { name: /^todo_api\.py/ }), { ms: 600 });
  await clickOn(page, page.getByRole("tab", { name: /Diff/ }), { ms: 500 });
  await page.waitForTimeout(1900);
  await clickOn(page, page.getByRole("tab", { name: /Project files/ }), { ms: 600 });
  await page.waitForTimeout(500);
  await clickOn(page, page.getByRole("treeitem", { name: /^index\.html/ }), { ms: 600 });
  await clickOn(page, page.getByRole("tab", { name: /Preview/ }), { ms: 600 });
  await cap(page, "…and a <b>live preview</b> of what they built", "Agents test it in a real browser too (Playwright MCP)");
  await page.waitForTimeout(3100);

  // ---- 7. Outro (54-60s)
  mark("outro");
  await page.setContent(card(`<div class="logo wig">${logo}</div>
     <h1 style="font-size:78px">Octopus</h1>
     <p>Assemble an AI company. Give it a goal. <b>Ship.</b></p>
     <div class="row"><span class="pill"><i>●</i> Runs locally</span><span class="pill">Azure OpenAI gpt-6-luna</span><span class="pill">Demo Mode, no keys</span><span class="pill">14 templates</span></div>
     <div style="height:18px"></div><code>github.com/bala2006/octopus</code>`));
  await page.waitForTimeout(5200);
  mark("end");
  await ctx.close();
  await browser.close();
} finally { srv.kill(); }
