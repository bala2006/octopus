/** Configuration from the environment (and an optional `.env` at the repository root). Read once at start-up. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key: string, fallback = "") => process.env[key]?.trim() || fallback;
const flag = (key: string, fallback: boolean) => {
  const v = env(key).toLowerCase();
  return v ? ["1", "true", "yes", "on"].includes(v) : fallback;
};
const list = (key: string, fallback: string[]) => {
  const v = env(key);
  return v ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : fallback;
};

const publicPort = Number(env("OCTOPUS_PORT", "8000"));

export const config = {
  appName: "Octopus",
  home: path.resolve(env("OCTOPUS_HOME", path.join(homedir(), ".octopus"))),
  /** The port this process listens on. In dev mode Vite owns the public port and proxies here. */
  port: Number(env("OCTOPUS_API_PORT", String(publicPort))),
  publicPort,
  host: "127.0.0.1",
  webDist: path.join(REPO_ROOT, "web", "dist"),
  azure: {
    baseUrl: env("AZURE_API_BASE"),
    apiKey: env("AZURE_API_KEY"),
    useEntra: flag("AZURE_USE_ENTRA", false),
  },
  defaultModel: env("DEFAULT_MODEL", "gpt-6-luna"),
  defaultEffort: env("DEFAULT_REASONING_EFFORT", "high"),
  nativeDialogs: flag("NATIVE_DIALOGS", true),
  browserEnabled: flag("BROWSER_ENABLED", true),
  browserHeadless: flag("PLAYWRIGHT_HEADLESS", true),
  allowStdioMcp: flag("MCP_ALLOW_STDIO", true),
  allowedRoots: list("WORKSPACE_ALLOWED_ROOTS", [homedir(), "/projects"]).map((p) => path.resolve(p.replace(/^~(?=$|[\\/])/, homedir()))),
  encryptionKey: env("ENCRYPTION_KEY"),
};
