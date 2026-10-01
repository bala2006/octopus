import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Layout and interaction regressions that only a real browser can catch (issues #28, #29, #31, #32, #35). */
const PROJECT = path.join(os.tmpdir(), "octopus-e2e", "projects", "ui-regressions");

async function setup(request: APIRequestContext): Promise<{ w: string; company: string }> {
  fs.mkdirSync(PROJECT, { recursive: true });
  const list = await (await request.get("/api/v1/workspaces")).json();
  const existing = list.find((x: { path: string }) => x.path === PROJECT);
  const w = existing?.id ?? (await (await request.post("/api/v1/workspaces", { data: { path: PROJECT, default_permission: "danger" } })).json()).id;
  const companies = await (await request.get(`/api/v1/w/${w}/companies`)).json();
  if (companies.length) return { w, company: companies[0].id };
  const c = await (await request.post(`/api/v1/w/${w}/companies/from-template`, { data: { template_key: "software_startup" } })).json();
  return { w, company: c.company.id };
}

const transformOf = (page: Page) => page.locator(".react-flow__viewport").first().evaluate((el) => (el as HTMLElement).style.transform);

test("chat sidebar: agents and history both get space and scroll with a large team (#28)", async ({ page, request }) => {
  const { w } = await setup(request);
  await page.setViewportSize({ width: 1440, height: 640 });
  await page.goto(`/w/${w}/chat`);
  const agents = page.getByTestId("chat-agents-list");
  const history = page.getByTestId("chat-history-list");
  await expect(agents.getByRole("listitem")).toHaveCount(8);
  const a = await agents.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
  expect(a.overflow).toBe("auto");
  expect(a.scroll).toBeGreaterThan(a.client); // 8 agents don't fit: the agents list scrolls instead of eating the column
  expect(await history.evaluate((el) => el.clientHeight)).toBeGreaterThan(120); // history used to collapse to ~0px
});

test("canvas quick-config: dragging inside the panel selects text and doesn't pan (#35); minimap shows the team (#29)", async ({ page, request }) => {
  const { w } = await setup(request);
  await page.goto(`/w/${w}/canvas`);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);

  // minimap: one labelled block per agent, an accessible summary
  const minimap = page.locator(".react-flow__minimap");
  await expect(minimap.locator("[data-testid^='minimap-node-']")).toHaveCount(8);
  await expect(minimap.locator("svg > title").first()).toContainText("Minimap of 8 agents");
  await expect(minimap.locator("text").first()).toHaveText(/^[A-Z?]{1,2}$/);

  await page.getByTestId("agent-node-Marcus").click();
  const panel = page.getByRole("dialog", { name: "Configure Marcus" });
  await expect(panel).toBeVisible();
  await expect(minimap).toBeVisible(); // it used to unmount while a quick-config panel was open

  const before = await transformOf(page);
  const name = panel.getByText("Marcus", { exact: true }).first();
  const box = (await name.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  expect(await transformOf(page)).toBe(before);
  expect((await page.evaluate(() => getSelection()?.toString() ?? "")).length).toBeGreaterThan(0);
});

test("settings: 'Preferences' fits on one line and matches its panel; #appearance still works (#31)", async ({ page, request }) => {
  const { w } = await setup(request);
  await page.goto(`/w/${w}/settings#appearance`);
  await expect(page.getByRole("heading", { name: "Preferences", level: 1 })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button", { name: "Preferences" })).toHaveAttribute("aria-current", "page");
  const heights = await nav.getByRole("button").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
});

test("runs page: outcome facts, honest status, reachable actions, single-line metrics (#32)", async ({ page, request }) => {
  const { w, company } = await setup(request);
  const run = await (await request.post(`/api/v1/w/${w}/runs`, {
    data: { company_id: company, goal: "Build a todo app with auth", permission_level: "danger", budget: { force_mock: true, max_turns: 80 } },
  })).json();
  await expect.poll(async () => (await (await request.get(`/api/v1/w/${w}/runs/${run.id}`)).json()).status, { timeout: 120_000 }).toBe("completed");

  await page.goto(`/w/${w}/runs`);
  const row = page.getByTestId(`run-row-${run.id}`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("run-facts")).toContainText(/\d+\/\d+ tasks done · \d+ files/);
  for (const action of ["Continue run", "Run again", "Open run files", "Download report", "Delete run"]) {
    await expect(row.getByRole("button", { name: action }).or(row.getByRole("link", { name: action }))).toBeVisible();
  }
  const metrics = row.getByText(/turns · .* tok ·/);
  expect((await metrics.boundingBox())!.height).toBeLessThan(20); // used to wrap onto two lines in a fixed 160px cell
  await page.getByRole("radio", { name: /^Live/ }).click();
  await expect(row).toBeHidden();
  await page.getByRole("radio", { name: /^All/ }).click();
  await page.getByLabel("Search runs by goal").fill("todo");
  await expect(row).toBeVisible();

  // the live run view has a minimap too, filled with each agent's run status
  await page.goto(`/w/${w}/runs/${run.id}`);
  await expect(page.getByLabel("Minimap legend")).toContainText("Done");
});

test("browser tab: see when an agent is browsing and what its tab shows, step by step", async ({ page, request }) => {
  const { w, company } = await setup(request);
  const run = await (await request.post(`/api/v1/w/${w}/runs`, {
    data: { company_id: company, goal: "Check the game in a browser", permission_level: "danger", budget: { force_mock: true, max_turns: 6 } },
  })).json();
  await expect.poll(async () => (await (await request.get(`/api/v1/w/${w}/runs/${run.id}`)).json()).status, { timeout: 120_000 }).not.toBe("running");
  const agent = ((await (await request.get(`/api/v1/w/${w}/runs/${run.id}`)).json()).snapshot.agents as { id: string; name: string }[])[0];

  // demo agents don't browse: replay the real run stream and add what a browsing agent produces
  const ev = (seq: number, type: string, data: Record<string, unknown>) => JSON.stringify({ type, seq, ts: new Date().toISOString(), data });
  const step = (seq: number, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ev(seq, "browser_action", { agent_id: agent.id, call_id: `b${seq}`, tool, args, ok: true, url: "http://127.0.0.1:8000/", title: "Snake", frame: null, ...extra });
  await page.routeWebSocket(/\/ws\/w\/.*\/runs\//, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      ws.send(m);
      if (typeof m === "string" && m.includes('"replay_done"')) {
        ws.send(step(100001, "browser_navigate", { url: "http://127.0.0.1:8000/" }, { frame: "000001.jpeg" }));
        ws.send(step(100002, "browser_click", { element: "Start game", target: "e7" }, { ok: false, note: "Ref e7 not found" }));
        ws.send(ev(100003, "agent_status", { agent_id: agent.id, status: "tool", activity: "Browser: type…" }));
      }
    });
  });
  await page.route(/\/browser\/000001\.jpeg$/, (r) => r.fulfill({ contentType: "image/jpeg", body: fs.readFileSync(path.resolve("e2e/fixtures/browser-frame.jpeg")) }));
  await page.goto(`/w/${w}/runs/${run.id}`);

  await page.getByTestId("agent-browsing").click(); // the agent strip says who's browsing; clicking opens the Browser tab
  const view = page.getByTestId("browser-view");
  await expect(view.getByTestId("browser-url")).toHaveText("http://127.0.0.1:8000/");
  await expect(view.getByTestId("browser-live")).toContainText("type");
  const steps = view.getByTestId("browser-steps");
  await expect(steps).toContainText("opened http://127.0.0.1:8000/");
  await expect(steps).toContainText("clicked “Start game”");
  await expect(steps).toContainText("Ref e7 not found");
  const img = view.getByTestId("browser-frame");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1280); // the real screenshot, loaded with auth
});
