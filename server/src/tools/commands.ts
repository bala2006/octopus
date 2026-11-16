/** shell: one command line in the project, run by PowerShell on Windows or bash elsewhere, with a timeout and a scrubbed environment. */
import path from "node:path";
import { z } from "zod";
import { run, safeEnv } from "../lib/proc";
import { spill } from "../lib/spill";
import { clip } from "../lib/util";
import { classifyShell } from "../safety/commands";
import { environmentPath } from "../workspace/environment";
import { defineTool } from "./types";

const DEFAULT_TIMEOUT_S = 180;
/** Output is kept whole up to this size, so the spill file holds everything the command printed. */
const CAPTURE_LIMIT = 10_000_000;

export const commandTools = [
  defineTool({
    name: "shell",
    description:
      "Run a command line in the project folder with the system shell (PowerShell on Windows, bash elsewhere). Pipes, `&&`, `||`, `;` " +
      "and redirects work, e.g. `npm test 2>&1 | Select-Object -Last 40`. Builds, tests and read-only commands run at once; installs, " +
      "Git changes and inline code may need approval; destructive commands (Remove-Item, rm, git reset --hard, sudo) are refused, so " +
      "delete files with delete_file. The output ends with `[exit code: N]`. Long-running servers time out: use start_dev_server for the project's dev server.",
    args: z.object({
      command: z.string().min(1),
      cwd: z.string().optional().describe("Folder relative to the project root"),
      timeout_s: z.number().int().min(1).max(900).optional().describe("Seconds before the command is stopped (default 180)"),
    }),
    async run(ctx, a, callId) {
      const cwd = ctx.fs.abs(a.cwd ?? "");
      const verdict = classifyShell(a.command, ctx.fs.root);
      if (verdict.risk === "deny") return { text: `Refused: ${verdict.reason}`, ok: false };
      if (verdict.risk !== "low") {
        await ctx.guard({ kind: "run_code", risk: verdict.risk === "high" ? "high" : "medium", summary: `Run \`${a.command}\`: ${verdict.reason}`, preview: a.command,
          details: { command: a.command, cwd: a.cwd ?? "." }, key: `run:${a.cwd ?? "."}:${a.command}` });
      }
      ctx.setStatus("running", a.command.slice(0, 80));
      const venv = environmentPath(ctx.fs.root);
      const env = safeEnv(venv ? { PATH: `${path.join(venv, process.platform === "win32" ? "Scripts" : "bin")}${path.delimiter}${process.env.PATH ?? ""}`, VIRTUAL_ENV: venv } : {});
      const shell = process.platform === "win32" ? ["pwsh", "-NoProfile", "-Command", a.command] : ["bash", "-c", a.command];
      const timeoutS = a.timeout_s ?? DEFAULT_TIMEOUT_S;
      const res = await run(shell, { cwd, env, direct: true, timeoutMs: timeoutS * 1000, maxOutput: CAPTURE_LIMIT, signal: ctx.signal });
      const body = res.output.trim();
      const shown = body ? spill(ctx.fs, callId, body).text : "(no output)";
      const cut = res.truncated ? `\n(output stopped at ${CAPTURE_LIMIT} characters)` : "";
      const status = res.timedOut ? `[timed out after ${timeoutS}s]` : `[exit code: ${res.code}]`;
      return { text: `$ ${a.command}\n${shown}${cut}\n${status}`, ok: res.code === 0 && !res.timedOut };
    },
  }),
  defineTool({
    name: "start_dev_server",
    description: "Start the project's dev server (its dev, start or preview script) in the background and get its URL, or get the URL of the one already running. Use this to open the app in the browser; do not start servers with shell.",
    args: z.object({}),
    async run(ctx) {
      ctx.setStatus("running", "Starting the dev server");
      const s = await ctx.devServer();
      const tail = clip(s.output.trim(), 3000);
      return s.url
        ? { text: `\`${s.command}\` is running at ${s.url}` }
        : { text: `\`${s.command}\` did not print a URL yet.\n${tail || "(no output)"}`, ok: false };
    },
  }),
];
