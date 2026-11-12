/**
 * Child processes without a shell: bounded output, a timeout that kills the whole process tree, and an environment
 * without the user's secrets. Used for agent commands, git, and the workspace terminal and dev server.
 */
import { spawn, type ChildProcess } from "node:child_process";

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|PRIVATE)/i;
const SECRET_PREFIX = /^(AZURE_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_|GH_|GITLAB_|OCTOPUS_|ENCRYPTION_|GOOGLE_|GCP_)/i;

/** The user's environment minus anything that looks like a credential. */
export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SECRET_ENV.test(k) && !SECRET_PREFIX.test(k)) env[k] = v;
  return { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

export interface ProcResult { code: number | null; output: string; timedOut: boolean; truncated: boolean }
export interface ProcOptions {
  cwd: string; timeoutMs?: number; maxOutput?: number; env?: NodeJS.ProcessEnv; input?: string;
  onOutput?: (chunk: string) => void; signal?: AbortSignal;
}

export function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Quote one argument for cmd.exe (only used on Windows, where .cmd shims such as npm need a shell). */
const winQuote = (a: string) => (/^[\w\-./:=@\\]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

export function start(argv: string[], opts: Omit<ProcOptions, "timeoutMs" | "maxOutput" | "input">): ChildProcess {
  const [cmd, ...args] = argv;
  const win = process.platform === "win32";
  return spawn(win ? argv.map(winQuote).join(" ") : cmd!, win ? [] : args, {
    cwd: opts.cwd, env: opts.env ?? safeEnv(), shell: win, detached: !win, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
}

export function run(argv: string[], opts: ProcOptions): Promise<ProcResult> {
  const max = opts.maxOutput ?? 60_000;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = start(argv, opts); } catch (e) { resolve({ code: 127, output: String((e as Error).message), timedOut: false, truncated: false }); return; }
    let output = "";
    let truncated = false;
    let timedOut = false;
    const take = (b: Buffer) => {
      const s = b.toString("utf8");
      opts.onOutput?.(s);
      if (output.length < max) output += s.slice(0, max - output.length);
      else truncated = true;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMs ?? 120_000);
    const abort = () => killTree(child);
    opts.signal?.addEventListener("abort", abort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      resolve({ code, output, timedOut, truncated });
    };
    child.on("error", (e) => { output += `\n${e.message}`; done(127); });
    child.on("close", (code) => done(code));
  });
}
