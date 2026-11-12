/** Every test run gets its own OCTOPUS_HOME and project root, and never touches a real model or browser. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const base = mkdtempSync(path.join(tmpdir(), "octopus-test-"));
process.env.OCTOPUS_HOME = path.join(base, "home");
process.env.WORKSPACE_ALLOWED_ROOTS = base;
process.env.BROWSER_ENABLED = "false";
process.env.NATIVE_DIALOGS = "false";
process.env.AZURE_API_BASE = "";
process.env.AZURE_API_KEY = "";
process.env.TEST_BASE_DIR = base;
