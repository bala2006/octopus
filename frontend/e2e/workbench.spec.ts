import { test, expect, type APIRequestContext } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function setup(request: APIRequestContext) {
  const root = path.join(
    os.tmpdir(),
    "octopus-e2e",
    "projects",
    `workbench-${Date.now()}`,
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "hello.txt"), "Original source\n");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      scripts: { test: "node -e \"console.log('Workbench task passed')\"" },
    }),
  );
  const response = await request.post("/api/v1/workspaces", {
    data: { path: root, default_permission: "ask" },
  });
  expect(response.ok()).toBeTruthy();
  const w = (await response.json()).id as string;
  const company = await request.post(`/api/v1/w/${w}/companies/from-template`, {
    data: { template_key: "solo_engineer", name: "Developer" },
  });
  expect(company.ok()).toBeTruthy();
  return { root, w, company: (await company.json()).company.id as string };
}

test("agent requests carry unsaved code context, stay beside the editor, and keep company drafts separate", async ({
  page,
  request,
}) => {
  const { root, w, company } = await setup(request);
  const second = await request.post(`/api/v1/w/${w}/companies/from-template`, {
    data: { template_key: "solo_engineer", name: "Reviewer" },
  });
  const otherCompany = (await second.json()).company.id as string;
  await page.goto(`/w/${w}/workspace?file=src%2Fhello.txt`);
  await page.getByLabel("Agent company").selectOption(company);
  const editor = page.locator(".monaco-editor").first();
  await editor.click({ position: { x: 120, y: 35 } });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Unsaved developer context\n");
  await page.getByRole("button", { name: "Attach current file" }).click();
  const message = page.getByRole("textbox", { name: "Message your company" });
  await message.fill("Build a todo app using the attached code");
  const submitted = page.waitForRequest(
    (r) => r.method() === "POST" && r.url().endsWith(`/w/${w}/runs`),
  );
  await page.getByRole("button", { name: "Send agent message" }).click();
  const body = (await submitted).postDataJSON();
  expect(body.company_id).toBe(company);
  expect(body.permission_level).toBe("ask");
  expect(body.goal).toContain("src/hello.txt (unsaved editor snapshot)");
  expect(body.goal).toContain("Unsaved developer context");
  await expect(page).toHaveURL(new RegExp(`/w/${w}/workspace`));
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Original source\n",
  );
  await expect(
    page.getByRole("button", { name: "Stop agent run" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop agent run" }).click();
  await message.fill("Developer company draft");
  await page.getByLabel("Agent company").selectOption(otherCompany);
  await expect(message).toHaveValue("");
  await message.fill("Reviewer company draft");
  await page.getByLabel("Agent company").selectOption(company);
  await expect(message).toHaveValue("Developer company draft");
  await expect(editor).toContainText("Unsaved developer context");
});

test("detected tasks prepare a real command and command output can be sent to the agent composer", async ({
  page,
  request,
}) => {
  const { w } = await setup(request);
  await page.goto(`/w/${w}/workspace?tool=commands`);
  await page
    .getByRole("button", { name: "Prepare test task", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Project command" }),
  ).toHaveValue('npm run "test"');
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(
    page.getByRole("log", { name: "Project command output" }),
  ).toContainText("Workbench task passed");
  await page
    .getByRole("button", { name: "Ask agent about command output" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message your company" }),
  ).toHaveValue(/Workbench task passed/);
  await expect(
    page.getByRole("textbox", { name: "Message your company" }),
  ).toBeFocused();
  await page.keyboard.press("Alt+1");
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await page.keyboard.press("Alt+7");
  await expect(page.getByTestId("workspace-editor")).toBeVisible();
});

test("Git commit uses reviewed staged content while preserving unstaged edits", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-b", "main");
  git("config", "user.name", "Workbench Test");
  git("config", "user.email", "workbench@example.invalid");
  git("add", "src/hello.txt");
  git("commit", "-m", "Initial source");
  fs.writeFileSync(path.join(root, "src/hello.txt"), "Reviewed source\n");
  await page.goto(`/w/${w}/workspace`);
  await page.getByRole("button", { name: "Git changes", exact: true }).click();
  await page.getByRole("button", { name: /src\/hello.txt/ }).click();
  const review = page.getByRole("dialog", { name: "src/hello.txt" });
  await expect(
    review.getByText("+Reviewed source", { exact: true }),
  ).toBeVisible();
  await review.getByRole("button", { name: "Stage file", exact: true }).click();
  await page.keyboard.press("Escape");
  fs.writeFileSync(path.join(root, "src/hello.txt"), "Later working edit\n");
  await page
    .getByRole("textbox", { name: "Commit message" })
    .fill("Commit reviewed source");
  await page
    .getByRole("button", { name: "Commit staged (1)", exact: true })
    .click();
  await expect
    .poll(() => git("log", "-1", "--format=%s").toString().trim())
    .toBe("Commit reviewed source");
  expect(git("show", "HEAD:src/hello.txt").toString()).toBe(
    "Reviewed source\n",
  );
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Later working edit\n",
  );
});

test("mobile workbench keeps the editor accessible and opens the agent as a dismissible pane", async ({
  page,
  request,
}) => {
  const { w } = await setup(request);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/w/${w}/workspace?file=src%2Fhello.txt`);
  await expect(page.getByTestId("agent-workbench")).not.toBeVisible();
  await page.getByRole("button", { name: "Toggle agent panel" }).click();
  await expect(page.getByTestId("agent-workbench")).toBeVisible();
  await page.getByRole("button", { name: "Hide agent panel" }).click();
  await expect(page.getByTestId("agent-workbench")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close src/hello.txt" }),
  ).toBeVisible();
});
