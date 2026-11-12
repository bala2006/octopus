/** run_command: one program with arguments, in the project, with a timeout and a scrubbed environment. */
import path from "node:path";
import { z } from "zod";
import { run, safeEnv } from "../lib/proc";
import { clip } from "../lib/util";
import { classify, parseCommand } from "../safety/commands";
import { environmentPath } from "../workspace/environment";
import { defineTool } from "./types";

export const commandTools = [
  defineTool({
    name: "run_command",
    description:
      "Run one command in the project folder, e.g. `npm test`, `python -m pytest -q`, `npx tsc --noEmit`. No shell: no pipes, " +
      "redirects, `&&` or `cd` (use `cwd`). Builds, tests and read-only tools run immediately; installs and Git changes may need " +
      "approval; destructive commands (rm, git reset --hard, sudo, …) are refused, so delete files with delete_file instead. " +
      "Long-running servers will time out: start them from the workspace instead.",
    args: z.object({
      command: z.string().min(1),
      cwd: z.string().optional().describe("Folder relative to the project root"),
      timeout_s: z.number().int().min(1).max(900).optional(),
    }),
    async run(ctx, a) {
      let argv: string[];
      try { argv = parseCommand(a.command); } catch (e) { return { text: (e as Error).message, ok: false }; }
      const cwd = ctx.fs.abs(a.cwd ?? "");
      const verdict = classify(argv, ctx.fs.root);
      if (verdict.risk === "deny") return { text: `Refused: ${verdict.reason}`, ok: false };
      if (verdict.risk !== "low") {
        await ctx.guard({ kind: "run_code", risk: verdict.risk === "high" ? "high" : "medium", summary: `Run \`${a.command}\`: ${verdict.reason}`, preview: a.command,
          details: { command: a.command, cwd: a.cwd ?? "." }, key: `run:${argv.slice(0, 2).join(" ")}` });
      }
      ctx.setStatus("running", a.command.slice(0, 80));
      const venv = environmentPath(ctx.fs.root);
      const env = safeEnv(venv ? { PATH: `${path.join(venv, process.platform === "win32" ? "Scripts" : "bin")}${path.delimiter}${process.env.PATH ?? ""}`, VIRTUAL_ENV: venv } : {});
      const res = await run(argv, { cwd, env, timeoutMs: (a.timeout_s ?? 180) * 1000, maxOutput: 40_000, signal: ctx.signal });
      const status = res.timedOut ? `timed out after ${a.timeout_s ?? 180}s` : `exit code ${res.code}`;
      return { text: `$ ${a.command}\n${clip(res.output.trim(), 16_000) || "(no output)"}\n[${status}${res.truncated ? ", output truncated" : ""}]`, ok: res.code === 0 && !res.timedOut };
    },
  }),
];
