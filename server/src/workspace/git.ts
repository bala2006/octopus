/** Git for the code workspace: status, diffs, staging, reviewed commits, branches and sibling worktrees. */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { GitBranch, GitCommit, GitLog, GitRef, GitStatus, LocalEnvironment } from "@octopus/shared";
import { config } from "../config";
import { run } from "../lib/proc";
import { sha1, UserError } from "../lib/util";
import type { ProjectFs } from "../safety/paths";
import { environments, selectedEnvironment } from "./environment";

/** Run git as the user (keeps their identity and config, but never prompts). */
export async function git(root: string, ...args: string[]): Promise<string> {
  const res = await run(["git", ...args], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: 60_000, maxOutput: 5_000_000 });
  if (res.code !== 0) throw new UserError(res.output.trim().split("\n").slice(-3).join("\n") || `git ${args[0]} failed`);
  return res.output;
}

export async function isRepo(root: string): Promise<boolean> {
  if (!existsSync(path.join(root, ".git"))) return false;
  try { return (await git(root, "rev-parse", "--show-toplevel")).trim().length > 0; } catch { return false; }
}

async function requireRepo(root: string) {
  if (!(await isRepo(root))) throw new UserError("This folder is not a Git repository");
}

const visible = (p: string) => !p.startsWith(".octopus/") && !p.startsWith(".git/");

export async function status(root: string): Promise<GitStatus> {
  await requireRepo(root);
  const branch = (await git(root, "branch", "--show-current")).trim() || "Detached HEAD";
  const parts = (await git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")).split("\0");
  const files: GitStatus["files"] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const original = /[RC]/.test(code) ? parts[++i] ?? null : null;
    const p = entry.slice(3);
    if (visible(p)) files.push({ path: p, status: code, original_path: original });
  }
  const index = await git(root, "diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-ext-diff");
  return { branch, files, index_revision: sha1(index) };
}

export async function diff(fs: ProjectFs, rel: string, staged: boolean): Promise<string> {
  await requireRepo(fs.root);
  return git(fs.root, "diff", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", `:(literal)${fs.rel(rel, "user")}`);
}

export async function stage(fs: ProjectFs, rel: string, staged: boolean): Promise<GitStatus> {
  const p = fs.rel(rel, "user");
  const current = await status(fs.root);
  if (!current.files.some((f) => f.path === p)) throw new UserError(`${p} has no changes`, 404);
  if (fs.isDir(p)) throw new UserError("Select an individual file to stage or unstage");
  await git(fs.root, ...(staged ? ["add", "--", `:(literal)${p}`] : ["restore", "--staged", "--", `:(literal)${p}`]));
  return status(fs.root);
}

export async function commit(root: string, message: string, expectedIndex: string) {
  const before = await status(root);
  if (before.index_revision !== expectedIndex) throw new UserError("The staged files changed since you reviewed them. Review the staged list and try again.", 409);
  if (!before.files.some((f) => f.status[0] !== " " && f.status !== "??")) throw new UserError("Stage at least one file first");
  await git(root, "commit", "-m", message);
  return { commit_sha: (await git(root, "rev-parse", "HEAD")).trim(), status: await status(root) };
}

const LOG_FORMAT = "%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e";

function refsOf(decorations: string): { refs: GitRef[]; head: boolean } {
  const refs: GitRef[] = [];
  let head = false;
  for (let item of decorations.split(", ")) {
    if (item === "HEAD") {
      head = true;
      continue;
    }
    if (item.startsWith("HEAD -> ")) {
      head = true;
      item = item.slice("HEAD -> ".length);
    }
    if (item.startsWith("tag: refs/tags/")) refs.push({ name: item.slice("tag: refs/tags/".length), kind: "tag" });
    else if (item.startsWith("refs/heads/")) refs.push({ name: item.slice("refs/heads/".length), kind: "branch" });
    else if (item.startsWith("refs/remotes/")) refs.push({ name: item.slice("refs/remotes/".length), kind: "remote" });
  }
  return { refs, head };
}

/** Reads the output of `git log` with LOG_FORMAT and --decorate=full. Exported for tests. */
export function parseLog(output: string): GitCommit[] {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [sha = "", parents = "", decorations = "", author = "", date = "0", subject = ""] = record.split("\x1f");
      return { sha, parents: parents ? parents.split(" ") : [], ...refsOf(decorations), author, date: Number(date), subject };
    });
}

/** Reads `git for-each-ref --format="%(refname) %(objectname) %(HEAD)"`. Git ref names contain no spaces. Exported for tests. */
export function parseBranches(output: string): GitBranch[] {
  return output.split("\n").flatMap((line): GitBranch[] => {
    const [ref = "", sha = "", head = ""] = line.trim().split(" ");
    if (ref.startsWith("refs/heads/")) return [{ name: ref.slice("refs/heads/".length), kind: "branch" as const, sha, current: head === "*" }];
    if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) {
      return [{ name: ref.slice("refs/remotes/".length), kind: "remote" as const, sha, current: false }];
    }
    return [];
  });
}
/** Recent commits on every local branch, remote, and tag, newest first, with HEAD marked. Every branch tip is listed, even when its commits fall outside the window. */
export async function log(root: string, limit = 80): Promise<GitLog> {
  await requireRepo(root);
  const anyRef = (await git(root, "rev-list", "--count", "--branches", "--remotes", "--tags")).trim();
  if (anyRef === "0") return { commits: [], branches: [] };
  const hasHead = await git(root, "rev-parse", "--verify", "--quiet", "HEAD").then(() => true, () => false);
  const output = await git(
    root,
    "log",
    "--topo-order",
    `--max-count=${limit}`,
    "--decorate=full",
    `--format=${LOG_FORMAT}`,
    "--branches",
    "--remotes",
    "--tags",
    ...(hasHead ? ["HEAD"] : []),
  );
  const branches = parseBranches(await git(root, "for-each-ref", "--format=%(refname) %(objectname) %(HEAD)", "refs/heads", "refs/remotes"));
  return { commits: parseLog(output), branches };
}
async function branches(root: string) {
  return (await git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads")).split("\n").filter(Boolean);
}

export async function localEnvironment(root: string): Promise<LocalEnvironment> {
  const base: LocalEnvironment = { repository: false, branch: "", branches: [], dirty_count: 0, worktrees: [], environments: environments(root), selected_environment: selectedEnvironment(root) };
  if (!(await isRepo(root))) return base;
  const st = await status(root);
  const worktrees: LocalEnvironment["worktrees"] = [];
  let cur: { path?: string; branch?: string } = {};
  for (const line of [...(await git(root, "worktree", "list", "--porcelain")).split("\n"), ""]) {
    if (!line) { if (cur.path) worktrees.push({ path: cur.path, branch: cur.branch ?? "Detached HEAD" }); cur = {}; continue; }
    const [k, ...v] = line.split(" ");
    if (k === "worktree") cur.path = v.join(" ");
    else if (k === "branch") cur.branch = v.join(" ").replace(/^refs\/heads\//, "");
  }
  return { ...base, repository: true, branch: st.branch, branches: await branches(root), dirty_count: st.files.length, worktrees };
}

export async function switchBranch(root: string, branch: string) {
  if (!(await branches(root)).includes(branch)) throw new UserError("Only existing local branches can be selected here");
  if ((await status(root)).files.length) throw new UserError("Commit or stash your local changes before switching branches, or start a new worktree", 409);
  await git(root, "switch", branch);
}

/** A sibling worktree on a new branch, so the team can work without touching your checkout. */
export async function createWorktree(root: string, baseBranch: string): Promise<{ dir: string; branch: string }> {
  if (!(await branches(root)).includes(baseBranch)) throw new UserError("Choose an existing local branch as the starting point");
  const stem = baseBranch.replace(/[^\w.-]+/g, "-").slice(0, 36) || "branch";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const branch = `octopus/${stem}-${stamp}`;
  const parent = path.join(path.dirname(root), ".octopus-worktrees", path.basename(root));
  if (!config.allowedRoots.some((r) => parent.startsWith(r + path.sep))) throw new UserError("The worktree folder would be outside the folders Octopus may use");
  mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, `${stem}-${stamp}`);
  await git(root, "worktree", "add", "-b", branch, dir, baseBranch);
  return { dir, branch };
}
