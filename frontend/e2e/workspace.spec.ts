import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function setup(request: APIRequestContext) {
  const root = path.join(
    os.tmpdir(),
    "octopus-e2e",
    "projects",
    `editor-${Date.now()}`,
  );
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "hello.txt"),
    "Hello workspace\nFind this needle\n",
  );
  fs.writeFileSync(
    path.join(root, "index.html"),
    "<!doctype html><html><head><title>Workspace preview</title></head><body><h1>Built in Octopus</h1><button onclick=\"this.textContent='It works'\">Try me</button></body></html>",
  );
  const response = await request.post("/api/v1/workspaces", {
    data: { path: root, default_permission: "ask" },
  });
  expect(response.ok()).toBeTruthy();
  const workspace = await response.json();
  return { root, w: String(workspace.id) };
}

async function typeCode(page: Page, text: string) {
  const editor = page.locator(".monaco-editor").first();
  await editor.click({ position: { x: 160, y: 35 } });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test("live command output survives navigation, receives input, and can be stopped", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  fs.writeFileSync(
    path.join(root, "prompt.py"),
    "from pathlib import Path\nprint('Live build output', flush=True)\nanswer = input('Enter name: ')\nPath('answer.txt').write_text(answer, encoding='utf-8')\nprint('Finished ' + answer, flush=True)\n",
  );
  fs.writeFileSync(
    path.join(root, "wait.py"),
    "import time\nprint('Waiting for stop', flush=True)\ntime.sleep(100)\n",
  );
  await page.goto(`/w/${w}/workspace?tool=commands`);
  await page
    .getByRole("textbox", { name: "Project command" })
    .fill("python prompt.py");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Enter name:");
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page
    .getByRole("link", { name: "Command running", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText("Live build output");
  await page
    .getByRole("textbox", { name: "Command input" })
    .fill("Octopus developer");
  await page.getByRole("button", { name: "Send command input" }).click();
  await expect(page.getByRole("log")).toContainText("Exit 0");
  expect(fs.readFileSync(path.join(root, "answer.txt"), "utf8")).toBe(
    "Octopus developer",
  );
  await page
    .getByRole("textbox", { name: "Project command" })
    .fill("python wait.py");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Waiting for stop");
  await page.getByRole("button", { name: "Stop command", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Project command" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Stop command", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Clear command output" }).click();
  await expect(page.getByRole("log")).toContainText(
    "Run a build, test, or Git command",
  );
});

test("upload and download binary assets, move folders with open tabs, and undo deletion", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  await page.goto(`/w/${w}/workspace?file=src%2Fhello.txt`);
  await expect(
    page.getByRole("button", { name: "Close src/hello.txt" }),
  ).toBeVisible();
  const data = Buffer.from([137, 80, 78, 71, 0, 255, 42]);
  await page
    .getByLabel("Choose upload file")
    .setInputFiles({ name: "icon.png", mimeType: "image/png", buffer: data });
  await page
    .getByRole("textbox", { name: "File or folder path" })
    .fill("src/assets/icon.png");
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for src/assets/icon.png" }),
  ).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/assets/icon.png"))).toEqual(data);
  await page
    .getByRole("button", { name: "Actions for src/assets/icon.png" })
    .click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Download file", exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("icon.png");
  const downloaded = await download.path();
  expect(downloaded && fs.readFileSync(downloaded)).toEqual(data);
  await page
    .getByRole("button", { name: "Actions for src", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Rename or move folder" }).click();
  await page.getByRole("textbox", { name: "File or folder path" }).fill("lib");
  await page.getByRole("button", { name: "Move folder", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close lib/hello.txt" }),
  ).toBeVisible();
  expect(fs.existsSync(path.join(root, "src"))).toBeFalsy();
  await page
    .getByRole("button", { name: "Actions for lib", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete folder", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Actions for lib", exact: true }),
  ).not.toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Actions for lib", exact: true }),
  ).toBeVisible();
  expect(fs.readFileSync(path.join(root, "lib/assets/icon.png"))).toEqual(data);
  await page
    .getByRole("button", { name: "Actions for lib/assets/icon.png" })
    .click();
  await page
    .getByRole("menuitem", { name: "Delete file", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete file", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Actions for lib/assets/icon.png" }),
  ).not.toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Project trash", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Restore lib/assets/icon.png", exact: true })
    .click();
  await expect(page.getByText("Trash is empty.")).toBeVisible();
  expect(fs.readFileSync(path.join(root, "lib/assets/icon.png"))).toEqual(data);
});

test("create, edit, save, rename, delete and undo using the real filesystem", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  await page.goto(`/w/${w}/workspace`);
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await page
    .getByRole("textbox", { name: "File or folder path" })
    .fill("src/new.txt");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await typeCode(page, "Saved from Octopus");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/new.txt"), "utf8")).toBe(
    "Saved from Octopus",
  );
  await page.getByRole("button", { name: "Rename or move file" }).click();
  await page
    .getByRole("textbox", { name: "File or folder path" })
    .fill("src/renamed.txt");
  await page.getByRole("button", { name: "Move file", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close src/renamed.txt" }),
  ).toBeVisible();
  expect(fs.existsSync(path.join(root, "src/new.txt"))).toBeFalsy();
  await page.getByRole("button", { name: "Delete file", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Delete file" })
    .click();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Close src/renamed.txt" }),
  ).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/renamed.txt"), "utf8")).toBe(
    "Saved from Octopus",
  );
});

test("search, quick open, preview, commands and responsive layout", async ({
  page,
  request,
}, testInfo) => {
  const { w } = await setup(request);
  await page.goto(`/w/${w}/workspace`);
  await page
    .getByRole("button", { name: "Search project", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Search file contents" })
    .fill("needle");
  await page.getByRole("button", { name: /src\/hello.txt:2/ }).click();
  await expect(
    page.getByRole("button", { name: "Close src/hello.txt" }),
  ).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await page
    .getByRole("combobox", { name: "Search files and pages" })
    .fill("index.html");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Close index.html" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const preview = page.frameLocator('iframe[title="Project preview"]');
  await expect(
    preview.getByRole("heading", { name: "Built in Octopus" }),
  ).toBeVisible();
  await preview.getByRole("button", { name: "Try me" }).click();
  await expect(preview.getByRole("button", { name: "It works" })).toBeVisible();
  const explorerResize = page.getByRole("separator", {
    name: "Resize explorer",
    exact: true,
  });
  const original = Number(await explorerResize.getAttribute("aria-valuenow"));
  await explorerResize.focus();
  await page.keyboard.press("ArrowRight");
  await expect(explorerResize).toHaveAttribute(
    "aria-valuenow",
    String(original + 16),
  );
  await expect(page.getByRole("complementary", { name: "Explorer" })).toHaveCSS(
    "width",
    `${original + 16}px`,
  );
  const previewResize = page.getByRole("separator", {
    name: "Resize preview",
    exact: true,
  });
  const bounds = await previewResize.boundingBox();
  if (!bounds) throw new Error("Preview resize handle is missing");
  const initialPreview = Number(
    await previewResize.getAttribute("aria-valuenow"),
  );
  await page.mouse.move(bounds.x + 2, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y + 40);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await previewResize.getAttribute("aria-valuenow")))
    .toBeGreaterThan(initialPreview);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Project command" })
    .fill("python --version");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Exit 0");
  await page
    .getByRole("separator", { name: "Resize commands", exact: true })
    .focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("separator", { name: "Resize commands", exact: true }),
  ).toHaveAttribute("aria-valuenow", "272");
  await page.screenshot({ path: testInfo.outputPath("workspace-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Hide commands" }).click();
  await page.getByRole("button", { name: "Hide explorer" }).click();
  await expect(
    page.getByRole("button", { name: "Close preview" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png") });
});

test("draft survives navigation and external writes cannot silently replace it", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  await page.goto(`/w/${w}/workspace?file=src%2Fhello.txt`);
  await typeCode(page, "My draft");
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.getByRole("link", { name: "Workspace", exact: true }).click();
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  fs.writeFileSync(path.join(root, "src/hello.txt"), "Changed by an agent");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("The file changed on disk.", { exact: false }),
  ).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Changed by an agent",
  );
  await page.getByRole("button", { name: "Keep my edits" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "My draft",
  );
  await typeCode(page, "Unsaved again");
  await page.getByRole("button", { name: "Close src/hello.txt" }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Discard unsaved changes?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
});

test("draft recovery survives a browser reload", async ({ page, request }) => {
  const { root, w } = await setup(request);
  await page.goto(`/w/${w}/workspace?file=src%2Fhello.txt`);
  await typeCode(page, "Recovered unfinished work");
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  // Wait for the real IndexedDB transaction, rather than a delay or store self-report.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string | null>((resolve) => {
            const request = indexedDB.open("octopus-editor", 1);
            request.onsuccess = () => {
              const db = request.result;
              const read = db
                .transaction("drafts")
                .objectStore("drafts")
                .get("workspace-drafts");
              read.onsuccess = () => {
                resolve(typeof read.result === "string" ? read.result : null);
                db.close();
              };
            };
          }),
      ),
    )
    .toContain("Recovered unfinished work");
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await expect(page.getByText("Unsaved", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor").first()).toContainText(
    "Recovered unfinished work",
  );
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Hello workspace\nFind this needle\n",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Recovered unfinished work",
  );
});

test("start a real development server, preview it, leave and return, then stop", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  fs.writeFileSync(
    path.join(root, "server.html"),
    "<h1>Server app</h1><script>localStorage.setItem('test', 'storage works'); fetch('./src/hello.txt').then(r => r.text()).then(text => document.body.append(text + localStorage.getItem('test')))</script>",
  );
  fs.writeFileSync(
    path.join(root, "serve.py"),
    "from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler\nserver = ThreadingHTTPServer(('127.0.0.1', 0), SimpleHTTPRequestHandler)\nprint('PORT=' + str(server.server_port), flush=True)\nserver.serve_forever()\n",
  );
  await page.goto(`/w/${w}/workspace`);
  await page.getByRole("button", { name: "Commands", exact: true }).click();
  await page.getByRole("button", { name: "Dev server", exact: true }).click();
  try {
    await page
      .getByRole("textbox", { name: "Development server command" })
      .fill("python serve.py");
    await page
      .getByRole("button", { name: "Start server", exact: true })
      .click();
    await expect(page.getByLabel("Development server output")).toContainText(
      "PORT=",
    );
    const output = await page
      .getByLabel("Development server output")
      .innerText();
    const port = /PORT=(\d+)/.exec(output)?.[1];
    expect(port).toBeTruthy();
    await page
      .getByRole("textbox", { name: "Development server address" })
      .fill(`127.0.0.1:${port}`);
    await page
      .getByRole("button", { name: "Open preview", exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="Project preview"]')
        .getByRole("heading", { name: "Built in Octopus" }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Preview address" })
      .fill(`127.0.0.1:${port}/server.html`);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(
      page.frameLocator('iframe[title="Project preview"]').locator("body"),
    ).toContainText("Hello workspace");
    await expect(
      page.frameLocator('iframe[title="Project preview"]').locator("body"),
    ).toContainText("storage works");
    await page.getByRole("link", { name: "Runs", exact: true }).click();
    await page
      .getByRole("link", { name: "Development server running", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Stop server", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Stop server", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start server", exact: true }),
    ).toBeVisible();
  } finally {
    await request.delete(`/api/v1/w/${w}/editor/server`);
  }
});

test("review real Git changes and stage and unstage one file", async ({
  page,
  request,
}) => {
  const { root, w } = await setup(request);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env });
  git("init", "-b", "main");
  git("add", "src/hello.txt", "index.html");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  );
  fs.writeFileSync(path.join(root, "src/hello.txt"), "Changed for review\n");
  await page.goto(`/w/${w}/workspace`);
  await page.getByRole("button", { name: "Git changes", exact: true }).click();
  await page.getByRole("button", { name: /src\/hello.txt/ }).click();
  const dialog = page.getByRole("dialog", { name: "src/hello.txt" });
  await expect(
    dialog.getByText("+Changed for review", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Stage file", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Staged changes", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(git("diff", "--cached").toString()).toContain("+Changed for review");
  await dialog
    .getByRole("button", { name: "Unstage file", exact: true })
    .click();
  await expect.poll(() => git("diff", "--cached").toString()).toBe("");
  expect(fs.readFileSync(path.join(root, "src/hello.txt"), "utf8")).toBe(
    "Changed for review\n",
  );
});
