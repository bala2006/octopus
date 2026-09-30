import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECT = path.join(os.tmpdir(), "octopus-e2e", "projects", "todo-app");
const SHOTS = path.resolve(process.cwd(), "../docs/screenshots");
const shoot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); }
};

test("create project → company from template → edit agent → run in Demo Mode → artifacts", async ({ page }) => {
  // 1. Workspace: pick a directory
  await page.goto("/");
  await expect(page.getByText("Create your first workspace")).toBeVisible();
  await shoot(page, "01-welcome");
  await page.getByTestId("open-folder").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("option", { name: /projects/ }).dblclick();
  await dialog.getByRole("option", { name: /todo-app/ }).click();
  await expect(dialog.getByText(PROJECT)).toBeVisible();
  await shoot(page, "02-directory-picker");
  await dialog.getByRole("button", { name: "Use this folder" }).click();
  await expect(page).toHaveURL(/\/w\/.+\/canvas/);
  expect(fs.existsSync(path.join(PROJECT, ".octopus", "octopus.db"))).toBeTruthy();

  // 2. Company from the Software Startup template
  await page.getByTestId("new-company").click();
  await page.getByTestId("create-company").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.getByText("8 agents · 14 channels")).toBeVisible();

  // 3. Click a node → quick config window next to it; rename the agent
  await page.getByTestId("agent-node-Marcus").click();
  const quick = page.getByRole("dialog", { name: "Configure Marcus" });
  await expect(quick).toBeVisible();
  await quick.getByLabel("Agent name").fill("Marcus Lee");
  await quick.getByRole("switch", { name: /Terminal/ }).click();
  await shoot(page, "03-canvas-quick-config");
  await expect(page.getByText(/^Saved/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByTestId("agent-node-Marcus Lee")).toBeVisible();

  // 4. Direct chat with streaming
  await page.getByRole("link", { name: "Chat" }).click();
  await page.getByTestId("chat-agent-Ava").click();
  await page.getByTestId("composer").fill("Please calculate 12*7");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/calculator returned/)).toBeVisible();
  await expect(page.getByText(/1 tool call/)).toBeVisible();
  await shoot(page, "04-direct-chat");

  // 5. Run the company in Demo Mode
  await page.getByRole("link", { name: "Canvas" }).click();
  await page.getByTestId("run-company").click();
  await page.getByTestId("run-goal").fill("Build a todo app with auth");
  await page.getByRole("radio", { name: /Danger/ }).click();
  await expect(page.getByRole("switch", { name: "Demo mode" })).toBeChecked();
  await page.getByTestId("start-run").click();
  await expect(page).toHaveURL(/\/runs\//);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await expect(page.getByText("Proposal").first()).toBeVisible();
  await shoot(page, "05-live-run");
  await expect(page.getByText("Completed", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Final report").first()).toBeVisible();
  await shoot(page, "06-run-completed");

  // 6. Report + artifacts, real files in the project directory
  await page.getByRole("tab", { name: /Report/ }).click();
  await expect(page.getByRole("heading", { name: "Key decisions" })).toBeVisible();
  expect(fs.readFileSync(path.join(PROJECT, "backend", "todo_api.py"), "utf8")).toContain("pbkdf2_hmac");
  await page.getByRole("link", { name: "Artifacts" }).first().click();
  await page.getByRole("treeitem", { name: /^todo_api\.py/ }).click();
  await expect(page.getByText("Version history")).toBeVisible();
  await expect(page.getByText("v2", { exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: /Diff/ }).click();
  await page.waitForTimeout(1200);
  await shoot(page, "07-artifacts-diff");

  // 7. Settings: Azure providers
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByText("Azure OpenAI", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Deployment names")).toHaveValue("gpt-6-luna");
  await shoot(page, "08-settings");
});

test("ask mode: approval card gates file writes", async ({ page, request }) => {
  const ws = (await (await request.get("/api/v1/workspaces")).json())[0];
  const companies = await (await request.get(`/api/v1/w/${ws.id}/companies`)).json();
  const run = await (await request.post(`/api/v1/w/${ws.id}/runs`, {
    data: { company_id: companies[0].id, goal: "Build a todo app (reviewed in ask mode)", permission_level: "ask", budget: { force_mock: true } },
  })).json();
  await page.goto(`/w/${ws.id}/runs/${run.id}`);
  const card = page.getByRole("alertdialog", { name: "Approval required" });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card.getByText("docs/PRD.md").first()).toBeVisible();
  await shoot(page, "09-approval");
  await card.getByRole("button", { name: "Always allow" }).click();
  await expect(card).toBeHidden();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: "Stop run" }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
});
