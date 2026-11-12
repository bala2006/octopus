/** Git for the code workspace: status, diffs, staging, reviewed commits, branches and sibling worktrees. */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { GitStatus, LocalEnvironment } from "@octopus/shared";
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
