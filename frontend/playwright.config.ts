import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** E2E runs the real backend (which serves the built UI) against an isolated Octopus home + project root. */
const root = path.join(os.tmpdir(), "octopus-e2e");
if (!process.env.OCTOPUS_E2E_INIT) {
  // the config is evaluated by the runner and by each worker; only the runner may reset the sandbox
  process.env.OCTOPUS_E2E_INIT = "1";
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "projects", "todo-app"), { recursive: true });
}
const PORT = 8766;

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, colorScheme: "dark", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `../backend/.venv/bin/python -m uvicorn app.main:app --app-dir ../backend --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      OCTOPUS_HOME: path.join(root, "home"),
      WORKSPACE_ALLOWED_ROOTS: JSON.stringify([path.join(root, "projects")]),
      MOCK_STREAM_DELAY: process.env.MOCK_STREAM_DELAY ?? "0.004",
      DEMO_MODE: "true",
      LOG_LEVEL: "WARNING",
    },
  },
});

export const E2E_PROJECTS = path.join(root, "projects");
