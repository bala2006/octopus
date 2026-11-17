import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { log, parseBranches } from "../src/workspace/git";

const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, env: identity, stdio: "ignore" });
}

function commitFile(cwd: string, file: string, subject: string) {
  writeFileSync(path.join(cwd, file), `${subject}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", subject);
}

describe("git log for the Git graph", () => {
  it("lists a merged branch with its parents, refs, and HEAD marker", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "octopus-git-log-"));
    git(repo, "init", "-b", "main");
    commitFile(repo, "a.txt", "first");
    git(repo, "checkout", "-b", "feature");
    commitFile(repo, "b.txt", "feature work");
    git(repo, "checkout", "main");
    commitFile(repo, "c.txt", "main work");
    git(repo, "merge", "--no-ff", "feature", "-m", "merge feature");

    const { commits, branches } = await log(repo);

    // The two branch commits share a timestamp, so their relative order is not part of the contract.
    expect(commits[0]!.subject).toBe("merge feature");
    expect(commits[3]!.subject).toBe("first");
    expect(commits.slice(1, 3).map((c) => c.subject).sort()).toEqual(["feature work", "main work"]);
    const bySubject = (subject: string) => commits.find((c) => c.subject === subject)!;
    const merge = bySubject("merge feature");
    expect(merge.parents).toHaveLength(2);
    expect(merge.head).toBe(true);
    expect(merge.refs).toEqual([{ name: "main", kind: "branch" }]);
    expect(bySubject("feature work").refs).toEqual([{ name: "feature", kind: "branch" }]);
    expect(bySubject("first").parents).toEqual([]);
    expect(commits.filter((c) => c.head).map((c) => c.sha)).toEqual([merge.sha]);

    expect(branches).toEqual([
      { name: "feature", kind: "branch", sha: bySubject("feature work").sha, current: false },
      { name: "main", kind: "branch", sha: merge.sha, current: true },
    ]);
  });

  it("returns no commits or branches for a repository with nothing committed", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "octopus-git-empty-"));
    git(repo, "init", "-b", "main");

    await expect(log(repo)).resolves.toEqual({ commits: [], branches: [] });
  });
});

describe("parseBranches", () => {
  it("reads local and remote branch tips and skips the remote HEAD alias", () => {
    const output = [
      "refs/heads/main aaa111 *",
      "refs/heads/feature bbb222 ",
      "refs/remotes/origin/main aaa111 ",
      "refs/remotes/origin/HEAD aaa111 ",
      "",
    ].join("\n");

    expect(parseBranches(output)).toEqual([
      { name: "main", kind: "branch", sha: "aaa111", current: true },
      { name: "feature", kind: "branch", sha: "bbb222", current: false },
      { name: "origin/main", kind: "remote", sha: "aaa111", current: false },
    ]);
  });
});
