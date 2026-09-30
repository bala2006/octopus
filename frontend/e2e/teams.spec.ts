import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const SHOTS = path.resolve(process.cwd(), "../docs/screenshots");
const shoot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
};

async function workspaceId(page: Page): Promise<string> {
  const list = await (await page.request.get("/api/v1/workspaces")).json();
  if (list.length) return list[0].id;
  const created = await (await page.request.post("/api/v1/workspaces", { data: { path: `${process.env.TMPDIR ?? "/tmp"}/octopus-e2e/projects/todo-app` } })).json();
  return created.id;
}

test("generate a company with AI → org panel → add department → save as template", async ({ page }) => {
  const w = await workspaceId(page);
  await page.goto(`/w/${w}/canvas`);
  await page.getByTestId("company-switcher").click();
  await page.getByRole("menuitem", { name: "New company…" }).click();
  await page.getByTestId("tab-generate").click();
  await page.getByTestId("generate-prompt").fill("Build and launch a habit tracker app with a marketing campaign");
  await page.getByTestId("generate").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Offline designer", { exact: true })).toBeVisible();
  for (const d of ["Engineering", "Product", "Quality", "Growth"]) await expect(dialog.getByText(d, { exact: true }).first()).toBeVisible();
  await shoot(page, "10-generate-company");
  await page.getByTestId("create-generated").click();
  await expect(page.getByText(/is ready/)).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();

  // org panel lists departments with managers; zones are drawn on the canvas
  const org = page.getByRole("tree", { name: "Org chart" });
  await expect(org.getByRole("treeitem", { name: "Engineering" })).toBeVisible();
  await expect(org.getByLabel("Manager").first()).toBeVisible();
  await expect(page.locator(".react-flow__viewport-portal").getByText("Engineering", { exact: true })).toBeVisible();

  // deactivate an agent from the org panel
  const firstDeactivate = org.getByRole("button", { name: /^Deactivate / }).first();
  await firstDeactivate.hover();
  await firstDeactivate.click();
  await expect(org.getByRole("button", { name: /^Activate / }).first()).toBeVisible();
  await expect(page.getByText(/1 inactive/).first()).toBeVisible();
  await shoot(page, "11-org-panel");

  // add a department with the builder
  await page.getByTestId("add-department").click();
  const builder = page.getByRole("dialog");
  await builder.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByTestId("create-department").click();
  await expect(page.getByText("Added Research department")).toBeVisible();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(org.getByRole("treeitem", { name: "Research" })).toBeVisible();
  await expect(page.getByText(/^Saved/)).toBeVisible({ timeout: 10_000 });

  // save as template → shows up under My templates
  await page.getByRole("button", { name: "Save as template" }).click();
  await page.getByTestId("save-template").click();
  await expect(page.getByText(/Available in New company/)).toBeVisible();
  await page.getByTestId("company-switcher").click();
  await page.getByRole("menuitem", { name: "New company…" }).click();
  await expect(page.getByRole("radiogroup", { name: "My templates" })).toBeVisible();
  await shoot(page, "12-templates");
});

test("self-organizing company hires its team live", async ({ page }) => {
  const w = await workspaceId(page);
  const c = await (await page.request.post(`/api/v1/w/${w}/companies/from-template`, { data: { template_key: "self_organizing" } })).json();
  expect(c.agents).toHaveLength(1);
  const run = await (await page.request.post(`/api/v1/w/${w}/runs`, {
    data: { company_id: c.company.id, goal: "Build a URL shortener", permission_level: "danger", budget: { force_mock: true } },
  })).json();
  await page.goto(`/w/${w}/runs/${run.id}`);
  await expect(page.getByText(/hired/).first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  await shoot(page, "13-self-organizing-live");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByTestId("tab-team").click();
  await expect(page.getByText(/hired by Nova/).first()).toBeVisible();
  await expect(page.getByText(/hired by Omar/).first()).toBeVisible();
  await shoot(page, "14-team-view");
  // the hires were saved to the company: the canvas shows them
  await page.getByRole("link", { name: "Canvas" }).click();
  await page.getByTestId("company-switcher").click();
  await page.getByRole("menuitem", { name: /Self-organizing Company/ }).first().click();
  await expect.poll(async () => page.locator(".react-flow__node").count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(6);
  await expect(page.getByText("AI hire").first()).toBeVisible();
  await shoot(page, "15-canvas-after-hiring");
});
