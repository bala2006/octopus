/**
 * The workspace terminal and dev server: one command and one server per project, started only by you, with live
 * output, input, and stop. They run through your shell with your environment minus provider keys.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { CommandStatus } from "@octopus/shared";
import { killTree, safeEnv } from "../lib/proc";
import { UserError } from "../lib/util";
import type { ProjectFs } from "../safety/paths";

const MAX_OUTPUT = 200_000;

class Proc {
  command = "";
  directory = ".";
  status: CommandStatus["status"] = "idle";
  exit_code: number | null = null;
  output = "";
  truncated = false;
  timed_out = false;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;

  view(): CommandStatus {
    const { command, directory, status, exit_code, output, truncated, timed_out } = this;
    return { command, directory, status, exit_code, output, truncated, timed_out };
  }

  start(fs: ProjectFs, command: string, directory = ".", timeoutS?: number) {
    if (this.status === "running") throw new UserError("Stop the running process first", 409);
    const cwd = fs.abs(directory === "." ? "" : directory, "user");
    Object.assign(this, { command, directory, status: "running", exit_code: null, output: "", truncated: false, timed_out: false });
    const shell = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] as const : [process.env.SHELL || "/bin/sh", ["-c", command]] as const;
    const child = spawn(shell[0], [...shell[1]], { cwd, env: safeEnv({ CI: "", FORCE_COLOR: "1", NO_COLOR: "" }), detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const take = (b: Buffer) => {
      this.output += b.toString("utf8");
      if (this.output.length > MAX_OUTPUT) { this.output = this.output.slice(-MAX_OUTPUT); this.truncated = true; }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (e) => { this.output += `\n${e.message}\n`; });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.status = "exited";
      this.exit_code = code;
      this.child = null;
      if (this.timer) clearTimeout(this.timer);
    });
    if (timeoutS) this.timer = setTimeout(() => { this.timed_out = true; this.stop(); }, timeoutS * 1000);
  }

  stop() {
    if (this.child) killTree(this.child);
  }

  input(text: string) {
    if (!this.child?.stdin?.writable) throw new UserError("No running process to send input to", 409);
    this.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  clear() { this.output = ""; this.truncated = false; }
}

const procs = new Map<string, { command: Proc; server: Proc }>();

export function processes(projectId: string) {
  let p = procs.get(projectId);
  if (!p) { p = { command: new Proc(), server: new Proc() }; procs.set(projectId, p); }
  return p;
}

export function stopAll() {
  for (const p of procs.values()) { p.command.stop(); p.server.stop(); }
}
