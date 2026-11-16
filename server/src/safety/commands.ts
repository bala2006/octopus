/**
 * Command safety. `classifyShell` reads a shell command line one segment at a time, and `classify` judges one argv:
 *
 *   low     builds, tests, linters, read-only inspection: runs without asking
 *   medium  installs, Git history changes, unknown programs, inline scripts: asks in "ask" mode
 *   high    publishing, pushing, remote access: always asks
 *   deny    anything that destroys work or leaves the project (rm, git reset --hard, sudo, paths outside): never runs
 *
 * Deleting goes through the delete_file tool instead, which moves files to a recoverable trash.
 */
import path from "node:path";
import { isSecretPath } from "./paths";

export type Risk = "low" | "medium" | "high" | "deny";
export interface Verdict { risk: Risk; reason: string }

/** Split a command line into argv, honouring quotes. Rejects shell syntax so a command can do one thing only. */
export function parseCommand(line: string): string[] {
  const argv: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) argv.push(cur); cur = ""; has = false; continue; }
    if ("|&;<>`".includes(c) || (c === "$" && line[i + 1] === "(")) {
      throw new Error(`Shell syntax (${c}) is not supported: run one command at a time, without pipes, redirects or &&.`);
    }
    if (c === "\\" && i + 1 < line.length && process.platform !== "win32") { cur += line[++i]; has = true; continue; }
    cur += c;
  }
  if (quote) throw new Error("Unclosed quote in command");
  if (has || cur) argv.push(cur);
  if (!argv.length) throw new Error("Empty command");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]!)) throw new Error("Setting environment variables inline is not supported");
  return argv;
}

const READ_ONLY = new Set(["ls", "dir", "cat", "type", "head", "tail", "wc", "grep", "rg", "egrep", "fgrep", "tree", "pwd", "echo", "which", "where",
  "diff", "sort", "uniq", "file", "stat", "du", "df", "date", "whoami", "uname", "printenv", "true", "false", "test", "basename", "dirname", "realpath",
  "sha256sum", "shasum", "md5sum", "jq", "less", "more", "cut", "tr", "column", "nl", "xxd", "od", "hexdump", "sleep",
  // PowerShell pipeline stages and read-only cmdlets (aliases included)
  "select", "select-object", "select-string", "where-object", "foreach", "foreach-object", "%", "?", "sort-object", "measure-object", "measure",
  "format-table", "ft", "format-list", "fl", "out-string", "get-content", "gc", "get-childitem", "gci", "write-output", "["]);
const BUILD = new Set(["tsc", "vite", "vitest", "jest", "mocha", "ava", "eslint", "prettier", "biome", "pytest", "mypy", "ruff", "black", "flake8",
  "pylint", "isort", "tox", "nox", "make", "cmake", "ninja", "gradle", "gradlew", "./gradlew", "mvn", "./mvnw", "javac", "java", "kotlinc", "swift",
  "swiftc", "xcodebuild", "rustc", "gcc", "g++", "clang", "clang++", "zig", "ruby", "rake", "rspec", "bundle", "php", "phpunit", "composer",
  "elixir", "mix", "dart", "flutter", "deno", "bun", "node", "python", "python3", "py", "go", "cargo", "dotnet", "mkdir", "touch", "playwright",
  "next", "nuxt", "astro", "webpack", "rollup", "esbuild", "turbo", "nx", "lerna", "storybook", "cypress", "sass", "tailwindcss", "postcss", "uv", "poetry",
  "hatch", "pdm", "terraform", "helm", "kubectl", "sqlite3", "psql", "mysql", "redis-cli", "chmod", "pip", "pip3", "npm", "pnpm", "yarn", "npx", "git",
  "docker", "curl", "wget", "find", "cp", "mv", "ln", "tar", "unzip", "zip", "gzip"]);
const DENY = new Set(["rm", "rmdir", "del", "erase", "rd", "shred", "unlink", "sudo", "su", "doas", "runas", "dd", "mkfs", "fdisk", "diskpart", "format",
  "shutdown", "reboot", "halt", "poweroff", "kill", "killall", "pkill", "taskkill", "chown", "chgrp", "crontab", "systemctl", "service", "launchctl",
  "reg", "regedit", "bcdedit", "setx", "passwd", "useradd", "userdel", "mount", "umount", "iptables", "ufw", "sh", "bash", "zsh", "fish", "dash",
  "ksh", "csh", "cmd", "cmd.exe", "eval", "exec", "xargs", "nohup", "env", "trash", "trash-put", "srm", "wipe", "truncate",
  "remove-item", "ri", "clear-content"]);
/** PowerShell cmdlets and aliases that write files or start programs. They ask before they run. */
const POWERSHELL_WRITE = new Set(["move-item", "mi", "rename-item", "rni", "set-content", "sc", "add-content", "ac", "out-file", "copy-item", "copy",
  "tee-object", "start-process", "start", "saps"]);
const WEB_REQUEST = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);
const REMOTE = new Set(["ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat", "netcat", "vercel", "netlify", "firebase", "fly", "flyctl", "heroku",
  "railway", "wrangler", "gh", "aws", "az", "gcloud", "doctl"]);

const v = (risk: Risk, reason: string): Verdict => ({ risk, reason });
const has = (args: string[], ...flags: string[]) => args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));

function gitVerdict(args: string[]): Verdict {
  let i = 0;
  while (args[i]?.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args.slice(0, i).includes("-c")) return v("deny", "Agents do not override Git configuration");
  const [sub = "", ...rest] = args.slice(i);
  const read = ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "remote", "describe", "shortlog", "grep", "config", "tag"];
  if (sub === "push") return has(rest, "--force", "-f", "--force-with-lease", "--delete", "--mirror") ? v("deny", "Force-pushing or deleting remote branches can destroy history") : v("high", "Pushes commits to a remote");
  if (sub === "reset" && has(rest, "--hard", "--merge", "--keep")) return v("deny", "git reset --hard discards uncommitted work");
  if (sub === "clean") return v("deny", "git clean permanently deletes untracked files");
  if ((sub === "checkout" || sub === "restore") && (rest.includes(".") || rest.includes("--") || has(rest, "--staged", "--worktree", "-f", "--force")))
    return v("deny", "This would discard uncommitted changes");
  if (sub === "branch" && has(rest, "-D", "-d", "--delete", "-f", "--force", "-m", "-M")) return v("deny", "Deleting or renaming branches can lose work");
  if (sub === "stash" && ["drop", "clear"].includes(rest[0] ?? "")) return v("deny", "Dropping stashes loses saved work");
  if (sub === "rebase" || sub === "filter-branch" || sub === "filter-repo" || sub === "gc" || sub === "prune" || sub === "reflog") return v("deny", "Rewrites or prunes Git history");
  if (sub === "config" && rest.length > 1 && !has(rest, "--get", "--list", "-l")) return v("deny", "Agents do not change Git configuration");
  if (sub === "tag" && rest.length && !has(rest, "-l", "--list")) return v("medium", "Creates or changes a tag");
  if (sub === "branch" && rest.length && !has(rest, "-a", "-r", "--list", "-l", "-v", "-vv", "--show-current")) return v("medium", "Creates a branch");
  if (read.includes(sub)) return v("low", "Reads repository state");
  return v("medium", `git ${sub} changes the repository`);
}

function packageVerdict(tool: string, args: string[]): Verdict {
  const sub = args[0] ?? "";
  if (tool === "npx") return v("medium", "npx can download and run packages");
  if (["publish", "unpublish", "deprecate", "owner", "login", "logout", "adduser", "token", "access", "dist-tag"].includes(sub)) return v("high", "Changes the package registry or your login");
  if (["install", "i", "add", "ci", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "dlx", "create", "init", "exec", "x"].includes(sub))
    return v("medium", "Installs or changes dependencies (uses the network)");
  if (sub === "run" || sub === "run-script" || ["test", "t", "start", "build", "lint", "dev", "preview", "check", "typecheck", "format"].includes(sub)) {
    const script = sub === "run" || sub === "run-script" ? args[1] ?? "" : sub;
    if (/deploy|publish|release|push|upload/i.test(script)) return v("high", `The ${script} script may publish or deploy`);
    return v("low", "Runs a project script");
  }
  if (["ls", "list", "outdated", "view", "info", "why", "audit", "config", "--version", "-v", "help"].includes(sub)) return v("low", "Reads package information");
  return v("medium", `${tool} ${sub}`.trim());
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, deny: 3 };
const worst = (a: Verdict, b: Verdict) => (RANK[b.risk] > RANK[a.risk] ? b : a);
export const exeName = (s: string) => path.basename(s).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

/** Programs that only adjust how another command runs: the command after them is what gets classified. */
const WRAPPERS = new Set(["timeout", "nice", "time", "stdbuf", "ionice", "chrt", "taskset", "unbuffer", "caffeinate", "xvfb-run", "flock", "watch", "strace", "ltrace", "gtimeout"]);
/** `<tool> <sub>` pairs that run an arbitrary command given after them. */
const RUNNERS: Record<string, string[]> = {
  uv: ["run", "tool"], uvx: [""], poetry: ["run"], pdm: ["run"], hatch: ["run"], pipx: ["run"], bundle: ["exec"], conda: ["run"], mamba: ["run"],
  pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"], npm: ["exec"], bunx: [""], dotenv: [""], "cross-env": [""], rye: ["run"],
};

/** The command that a wrapper or runner actually executes, or null when argv runs itself. */
function innerCommand(argv: string[]): string[] | null {
  const exe = exeName(argv[0]!);
  let rest: string[] | null = null;
  if (WRAPPERS.has(exe)) rest = argv.slice(1);
  else if (RUNNERS[exe]?.includes("")) rest = argv.slice(1);
  else if (RUNNERS[exe]?.includes(argv[1] ?? "")) rest = argv.slice(2);
  if (!rest) return null;
  // skip the wrapper's own options and values (timeout 5, nice -n 10, uv run --with x)
  let i = 0;
  while (i < rest.length && (rest[i]!.startsWith("-") || /^[\d.]+[smhd]?$/.test(rest[i]!))) i += rest[i]!.startsWith("--") && !rest[i]!.includes("=") && /^--(with|from|python|env|directory|project|package)$/.test(rest[i]!) ? 2 : rest[i] === "-n" || rest[i] === "-k" || rest[i] === "-s" ? 2 : 1;
  return rest.slice(i);
}

function outside(root: string, value: string): boolean {
  // A drive path names another disk on Windows. Elsewhere path.resolve would read it as a folder inside the project.
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) return true;
  const resolved = path.resolve(root, value);
  return resolved !== root && !resolved.startsWith(root + path.sep) && resolved !== "/dev/null";
}

/** Path checks on every argument, including values glued to flags (`-o../x`, `--out=../x`). */
export function argumentVerdict(exe: string, args: string[], root: string): Verdict | null {
  for (const a of args) {
    const values = [a, a.includes("=") ? a.slice(a.indexOf("=") + 1) : a, a.replace(/^-{1,2}[A-Za-z]+/, "")];
    for (const value of values) {
      if (!value) continue;
      if (value.startsWith("~")) return v("deny", "Paths in your home folder are outside the project");
      if ((path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) && outside(root, value)) return v("deny", `${value} is outside the project`);
      if (/(^|[\\/])\.\.([\\/]|$)/.test(value) && outside(root, value)) return v("deny", `${value} is outside the project`);
      if (/(^|[\\/])\.git([\\/]|$)/i.test(value) && exe !== "git") return v("deny", "The .git folder is managed by Git");
      if (/(^|[\\/])\.octopus([\\/]|$)/i.test(value) && !/\.octopus[\\/]work([\\/]|$)/i.test(value)) return v("deny", ".octopus is managed by Octopus");
    }
  }
  return null;
}

/** Classify an agent command. `root` is the project folder: paths outside it are refused. */
export function classify(argv: string[], root: string, depth = 0): Verdict {
  const inner = depth < 4 ? innerCommand(argv) : null;
  if (inner) {
    if (!inner.length) return v("medium", `${exeName(argv[0]!)} without a command`);
    const own = argumentVerdict(exeName(argv[0]!), argv.slice(1), root) ?? v("low", "");
    const exe = exeName(argv[0]!);
    const floor = ["uvx", "bunx", "pipx"].includes(exe) || ["dlx", "tool"].includes(argv[1] ?? "") ? v("medium", `${exe} can download and run packages`) : v("low", "");
    return worst(worst(own, floor), classify(inner, root, depth + 1));
  }
  const verdict = classifyOne(argv, root, depth);
  const secret = argv.slice(1).find((a) => isSecretPath(a.replace(/^-{1,2}[A-Za-z]+=?/, "")));
  return secret && RANK[verdict.risk] < RANK.high ? v("high", `Reads or uses ${secret}, which looks like a secrets file`) : verdict;
}

function classifyOne(argv: string[], root: string, depth: number): Verdict {
  const exe = exeName(argv[0]!);
  const args = argv.slice(1);
  const pathProblem = argumentVerdict(exe, args, root);
  if (pathProblem) return pathProblem;
  if (exe === "pwsh" || exe === "powershell") return powershellVerdict(args, root, depth);
  if (DENY.has(exe)) {
    const hint = ["rm", "rmdir", "del", "erase", "rd", "unlink", "trash", "remove-item", "ri", "clear-content"].includes(exe) ? " Use the delete_file tool: it moves files to a recoverable trash." : "";
    return v("deny", `${exe} is not allowed for agents.${hint}`);
  }
  if (REMOTE.has(exe)) return v("high", `${exe} reaches remote machines or accounts`);
  if (exe === "git") return gitVerdict(args);
  if (["npm", "pnpm", "yarn", "bun", "npx"].includes(exe) && !(exe === "bun" && (args[0]?.endsWith(".ts") || args[0]?.endsWith(".js")))) return packageVerdict(exe, args);
  const sub = args[0] ?? "";
  if (POWERSHELL_WRITE.has(exe)) return v("medium", `${exe} writes files or starts a program`);
  if (WEB_REQUEST.has(exe)) return v("medium", args.some((a) => /^-outf/i.test(a)) ? "Downloads into a file" : "Uses the network");
  if (sub === "publish" && ["uv", "poetry", "cargo", "dotnet", "twine", "gem", "hatch", "pdm"].includes(exe)) return v("high", "Publishes a package");
  if (exe === "pip" || exe === "pip3") return ["list", "show", "freeze", "check", "--version"].includes(sub) ? v("low", "Reads packages") : v("medium", "Installs packages (uses the network)");
  if (["uv", "poetry", "composer", "hatch", "pdm"].includes(exe)) return ["build", "test", "check", "show", "list", "--version"].includes(sub) ? v("low", "Runs a project task") : v("medium", "Changes dependencies (uses the network)");
  if ((exe === "cargo" && ["install", "add", "remove", "update"].includes(sub)) || (exe === "go" && ["install", "get"].includes(sub))) return v("medium", "Changes dependencies (uses the network)");
  if (["python", "python3", "py", "node", "deno", "bun", "ruby", "php", "perl", "lua", "tsx", "ts-node"].includes(exe)) {
    const inline = args.some((a) => /^-[A-Za-z]*[cepr]/.test(a) && !a.startsWith("--")) || has(args, "--eval", "--print", "--require", "--import", "--loader");
    if (inline || (exe === "deno" && ["eval", "repl"].includes(args[0] ?? ""))) return v("medium", "Runs inline code");
    if (args[0] === "-m" && ["pip", "venv"].includes(args[1] ?? "")) return v("medium", `${args[1]} changes the environment`);
    return v("low", "Runs a project script");
  }
  if (exe === "docker") {
    const sub = args[0] ?? "";
    if (["push", "login", "logout"].includes(sub)) return v("high", "Publishes images or changes your login");
    if (["rm", "rmi", "prune", "system", "volume", "network", "kill"].includes(sub)) return v("deny", "Removes Docker resources outside this project");
    return ["ps", "images", "logs", "inspect", "version", "info", "build"].includes(sub) ? v("low", "Docker") : v("medium", `docker ${sub}`);
  }
  if (exe === "find") return has(args, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint") ? v("deny", "find can only search") : v("low", "Searches files");
  if (exe === "sed" || exe === "awk" || exe === "perl") return v("medium", `${exe} scripts can write files and run commands; use edit_file to change files`);
  if (exe === "chmod") return has(args, "-R", "--recursive") ? v("deny", "Recursive permission changes") : v("medium", "Changes file permissions");
  if (["cp", "mv", "ln", "tar", "unzip", "zip", "gzip"].includes(exe)) return v("medium", `${exe} can overwrite files; prefer move_file and write_file`);
  if (exe === "curl" || exe === "wget") return v("medium", "Uses the network");
  if (["terraform", "helm", "kubectl"].includes(exe)) return ["plan", "validate", "fmt", "version", "get", "describe", "template", "lint"].includes(args[0] ?? "") ? v("low", exe) : v("high", `${exe} changes infrastructure`);
  if (["psql", "mysql", "redis-cli", "sqlite3"].includes(exe)) return v("medium", "Talks to a database");
  if (["cargo", "go", "dotnet", "mvn", "gradle", "./gradlew", "./mvnw"].includes(exe) && ["publish", "deploy", "push", "nuget"].some((s) => args.includes(s))) return v("high", "Publishes or deploys");
  if (["go", "cargo", "dotnet"].includes(exe) && args[0] === "run") return v("low", "Runs the project");
  if (READ_ONLY.has(exe) || BUILD.has(exe)) return v("low", READ_ONLY.has(exe) ? "Read-only" : "Build or test tool");
  if (argv[0]!.startsWith("./") || argv[0]!.startsWith(".\\")) return v("medium", "Runs a project executable");
  return v("medium", `${exe} is not a known build or test tool`);
}

/** `pwsh -Command <text>` runs <text> as PowerShell, so that text is classified like any other command line. */
function powershellVerdict(args: string[], root: string, depth: number): Verdict {
  if (args.some((a) => /^-e[a-z]*$/i.test(a) && "-encodedcommand".startsWith(a.toLowerCase()))) return v("medium", "-EncodedCommand hides the command, which cannot be read");
  const at = args.findIndex((a) => /^-c[a-z]*$/i.test(a) && "-command".startsWith(a.toLowerCase()));
  if (at < 0) return v("medium", "PowerShell without -Command runs a script or waits for input");
  if (depth >= 4) return v("medium", "Nested shells are not read");
  return classifyShell(args.slice(at + 1).join(" "), root, depth + 1);
}

/** The parts of a shell command line: each segment's argv, the redirect targets, and the constructs that cannot be read. */
export interface ShellParts { segments: string[][]; targets: string[]; unreadable: string[] }

/** Operators split a line into segments: pipes, `&&`, `||`, `;`, `&`, newlines. Braces and parentheses split too, so a script block is read as commands. */
const SEGMENT_BREAKS = new Set([";", "(", ")", "{", "}"]);

/** Split a PowerShell or bash command line. Quotes keep operators inside a word. Constructs that run code inside the line are reported as unreadable. */
export function splitShell(line: string): ShellParts {
  const segments: string[][] = [];
  const targets: string[] = [];
  const unreadable: string[] = [];
  const escapes = process.platform !== "win32";
  let words: string[] = [];
  let cur = "";
  let has = false;
  let pendingTarget = false;
  let quote: '"' | "'" | null = null;

  if (line.includes("$(")) unreadable.push("$(...) runs a command inside the command");
  if (line.includes("`")) unreadable.push("Backticks run a command inside the command");
  if (/[<>]\(/.test(line)) unreadable.push("Process substitution runs a command inside the command");

  const endWord = () => {
    if (has) {
      if (pendingTarget) { targets.push(cur); pendingTarget = false; } else words.push(cur);
    }
    cur = "";
    has = false;
  };
  const endSegment = () => {
    endWord();
    pendingTarget = false;
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && escapes && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === "\\" && escapes && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (c === "\n" || c === "\r") { endSegment(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === "|") { endSegment(); if (line[i + 1] === "|" || line[i + 1] === "&") i++; continue; }
    if (c === "&") {
      if (line[i + 1] === "&") { endSegment(); i++; }
      else if (!has && !words.length) unreadable.push("A leading & runs a command by name, which cannot be read");
      else endSegment();
      continue;
    }
    if (c === ">" || c === "<") {
      // `2>` and `*>` name a stream, not a file; `2>&1` duplicates a stream and has no target.
      if (/^\d+$/.test(cur) || cur === "*") { cur = ""; has = false; } else endWord();
      while (line[i + 1] === ">" || line[i + 1] === "<") i++;
      if (line[i + 1] === "&") { i++; while (/\d/.test(line[i + 1] ?? "")) i++; } else pendingTarget = true;
      continue;
    }
    if (c === "$" && line[i + 1] === "{") {
      const end = line.indexOf("}", i);
      const stop = end < 0 ? line.length - 1 : end;
      cur += line.slice(i, stop + 1);
      has = true;
      i = stop;
      continue;
    }
    if (SEGMENT_BREAKS.has(c)) {
      if (c === "(" && (has || cur)) unreadable.push("A call like name(...) runs a method that cannot be read");
      endSegment();
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) unreadable.push("The command has an unclosed quote");
  endSegment();
  return { segments, targets, unreadable };
}

/** Classify a shell command line. Each segment is judged on its own, and the riskiest verdict is the command's. */
export function classifyShell(line: string, root: string, depth = 0): Verdict {
  const parts = splitShell(line);
  const found: Verdict[] = [v("low", "Nothing to run")];
  for (const reason of parts.unreadable) found.push(v("medium", reason));
  for (const target of parts.targets) {
    const problem = argumentVerdict("", [target], root);
    if (problem) found.push(problem);
  }
  for (const segment of parts.segments) {
    if (/^(iex|invoke-expression)$/i.test(segment[0]!)) found.push(v("medium", "Invoke-Expression runs text that cannot be read"));
    found.push(segmentVerdict(segment, root, depth));
  }
  return found.reduce(worst);
}

/** A segment is a PowerShell expression when it starts with a variable, a type, a hashtable or a number. Expressions do no work by themselves. */
function segmentVerdict(argv: string[], root: string, depth: number): Verdict {
  const dotnet = argv.some((a) => a.includes("::")) ? v("medium", "Calls .NET code, which cannot be read") : v("low", "Nothing to run");
  const first = argv[0]!;
  const expression = first !== "[" && /^(\$|@|\[|\d+$)/.test(first);
  const body = expression
    ? (argv.some((a) => a.includes("=")) ? v("medium", "Assigns a value, which may change an object") : v("low", "A PowerShell expression"))
    : classify(argv, root, depth);
  return worst(dotnet, body);
}

/**
 * The check-only policy, for read-only specialists. A command runs only when it reads, tests, lints or builds. The
 * policy decides from the command text alone, so it never asks, and it names the rule a refused command broke.
 */
export type CheckVerdict = { allowed: true } | { allowed: false; rule: string; reason: string };

const ALLOWED: CheckVerdict = { allowed: true };
const refuse = (rule: string, reason: string): CheckVerdict => ({ allowed: false, rule, reason });

/** Flags that write a file, update a snapshot or upload one. A check command with any of them is refused. */
const CHECK_WRITE_FLAGS = ["--fix", "--write", "-u", "--update", "--update-snapshot", "-o", "--output", "--outfile", "-O", "--remote-name", "-T", "--upload-file", "-F", "--form"];
/** Read-only programs and PowerShell cmdlets that may follow a check command in a pipeline. */
const CHECK_PIPE_STAGES = new Set(["select-object", "select", "select-string", "where-object", "where", "sort-object", "measure-object", "measure",
  "format-table", "format-list", "out-string", "foreach-object", "foreach", "%", "?", "get-content", "gc", "head", "tail", "grep", "wc", "cat", "sort", "uniq", "findstr", "more", "less"]);
const CHECK_SCRIPT = /^(test|typecheck|lint|build|check|validate)(:[\w.-]+)?$/;
const CHECK_TOOLS = new Set(["vitest", "jest", "pytest", "mypy", "eslint"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_CHANGES = new Set(["install", "i", "add", "ci", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "link", "unlink", "dedupe", "prune"]);
const GIT_READS = new Set(["status", "diff", "log", "show"]);
const PYTHON_MODULES = new Set(["pytest", "unittest", "mypy", "ruff"]);
const INLINE_CODE = new Set(["-e", "--eval", "-p", "--print", "-c", "--command", "-r"]);
const CHECK_RUNNERS = new Set(["npx", "pnpx", "bunx", "dlx"]);

const isWriteFlag = (arg: string) => CHECK_WRITE_FLAGS.some((f) => arg === f || (f.startsWith("--") && arg.startsWith(`${f}=`)));

function checkSegment(argv: string[], root: string): CheckVerdict {
  const exe = exeName(argv[0]!);
  const args = argv.slice(1);
  const writeFlag = args.find(isWriteFlag);
  if (writeFlag) return refuse("write-flag", `${writeFlag} writes files, updates snapshots or uploads, and check-only commands cannot`);
  if (CHECK_PIPE_STAGES.has(exe)) return ALLOWED;
  const outside = argumentVerdict(exe, args, root);
  if (outside?.risk === "deny") return refuse("outside-project", outside.reason);
  const sub = args[0] ?? "";
  if (exe === "git") return GIT_READS.has(sub) ? ALLOWED : refuse("git-change", `git ${sub} may change the repository; only status, diff, log and show are allowed`);
  if (exe === "ls" || exe === "dir") return args.length === 0 || (args.length === 1 && !args[0]!.startsWith("-")) ? ALLOWED : refuse("not-allowed", `${exe} lists one folder, or the project folder when no path is given`);
  if (exe === "pwd") return args.length === 0 ? ALLOWED : refuse("not-allowed", "pwd takes no arguments");
  if (CHECK_RUNNERS.has(exe)) return refuse("not-allowed", `${exe} can download and run packages`);
  if (PACKAGE_MANAGERS.has(exe)) {
    if (PACKAGE_CHANGES.has(sub)) return refuse("install", `${exe} ${sub} installs or changes packages`);
    if (["test", "t", "typecheck", "lint", "build", "check"].includes(sub)) return ALLOWED;
    if (sub === "run" || sub === "run-script") return CHECK_SCRIPT.test(args[1] ?? "") ? ALLOWED : refuse("not-allowed", `${exe} run ${args[1] ?? ""} is not a test, typecheck, lint or build script`);
    if (sub === "audit") return args[1] === "fix" ? refuse("write-flag", "npm audit fix changes package files") : ALLOWED;
    return refuse("not-allowed", `${exe} ${sub} is not a check command`);
  }
  if (CHECK_TOOLS.has(exe)) return ALLOWED;
  if (exe === "tsc") return args.includes("--noEmit") ? ALLOWED : refuse("write-flag", "tsc writes its output unless --noEmit is given");
  if (exe === "prettier") return args.some((a) => a === "--check" || a === "-c" || a === "-l" || a === "--list-different") ? ALLOWED : refuse("not-allowed", "prettier is allowed only with --check");
  if (exe === "ruff") return sub === "check" ? ALLOWED : refuse("not-allowed", "ruff is allowed only as ruff check");
  if (["node", "python", "python3", "py"].includes(exe)) {
    if (args.some((a) => INLINE_CODE.has(a))) return refuse("inline-code", `${exe} runs code typed on the command line, which cannot be read; put it in a script`);
    if (args[0] === "-m") return PYTHON_MODULES.has(args[1] ?? "") ? ALLOWED : refuse("not-allowed", `${exe} -m ${args[1] ?? ""} is not a check module`);
    if (!args.length) return refuse("inline-code", `${exe} needs a script file`);
    if (exe === "node" && sub === "--check") return args.length === 2 && !args[1]!.startsWith("-") ? ALLOWED : refuse("not-allowed", "node --check takes one script file");
    if (exe === "node" && sub === "--test") return ALLOWED;
    return sub.startsWith("-") ? refuse("not-allowed", `${exe} ${sub} is not a script`) : ALLOWED;
  }
  if (exe === "curl") return ALLOWED;
  return refuse("not-allowed", `${exe} is not a check command. Allowed: tests, typecheck, lint, build, read-only Git, ls, pwd, node --check, node and python scripts, and curl without upload flags`);
}

/** Judge a command line for a read-only specialist. Redirects, unreadable constructs and any segment outside the allowed set are refused. */
export function checkOnly(line: string, root: string): CheckVerdict {
  const parts = splitShell(line);
  if (parts.unreadable.length) return refuse("unreadable", `${parts.unreadable[0]}, so the command cannot be checked`);
  if (parts.targets.length) return refuse("redirect", `a redirect writes to ${parts.targets[0]}`);
  if (!parts.segments.length) return refuse("not-allowed", "the command is empty");
  for (const segment of parts.segments) {
    const verdict = checkSegment(segment, root);
    if (!verdict.allowed) return verdict;
  }
  return ALLOWED;
}
