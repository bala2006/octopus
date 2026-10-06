import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const frontend = fileURLToPath(new URL("..", import.meta.url));
const backend = resolve(frontend, "../backend");
const python =
  process.env.OCTOPUS_PYTHON ??
  resolve(
    backend,
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python",
  );
if (!existsSync(python))
  throw new Error(
    "Create backend/.venv and install backend/requirements.txt first, or set OCTOPUS_PYTHON to your Python executable.",
  );
for (const [executable, args, cwd] of [
  [
    python,
    ["-m", "app.export_openapi", resolve(frontend, "openapi.json")],
    backend,
  ],
  [
    process.execPath,
    [
      resolve(frontend, "node_modules/openapi-typescript/bin/cli.js"),
      "openapi.json",
      "-o",
      "src/types/api.gen.ts",
    ],
    frontend,
  ],
]) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
