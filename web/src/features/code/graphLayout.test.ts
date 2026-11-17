import { describe, expect, it } from "vitest";
import type { GitBranch, GitCommit } from "@octopus/shared";
import { layoutBranches } from "./graphLayout";

const commit = (sha: string, parents: string[] = [], head = false): GitCommit => ({
  sha,
  parents,
  refs: [],
  head,
  author: "Test",
  date: 0,
  subject: sha,
});
const local = (name: string, sha: string, current = false): GitBranch => ({ name, kind: "branch", sha, current });
const remote = (name: string, sha: string): GitBranch => ({ name, kind: "remote", sha, current: false });

describe("layoutBranches", () => {
  it("puts a straight history on the current branch's row", () => {
    const commits = [commit("c", ["b"], true), commit("b", ["a"]), commit("a")];
    const { rows, nodes, links } = layoutBranches(commits, [local("main", "c", true)]);

    expect(rows.map((r) => r.name)).toEqual(["main"]);
    expect(nodes.map((n) => n.row)).toEqual([0, 0, 0]);
    expect(links).toHaveLength(2);
  });

  it("gives each branch its own row and returns a merged branch to the main row", () => {
    // M merges F (feature) into B (main). F and B both descend from A.
    const commits = [commit("M", ["B", "F"], true), commit("F", ["A"]), commit("B", ["A"]), commit("A")];
    const { rows, nodes, links } = layoutBranches(commits, [local("feature", "F"), local("main", "M", true)]);
    const row = (sha: string) => nodes.find((n) => n.sha === sha)!.row;

    expect(rows.map((r) => r.name)).toEqual(["main", "feature"]);
    expect(row("M")).toBe(0);
    expect(row("B")).toBe(0);
    expect(row("A")).toBe(0);
    expect(row("F")).toBe(1);
    expect(links).toHaveLength(4);
  });

  it("keeps a branch row even when its tip is older than the loaded history", () => {
    const commits = [commit("c", [], true)];
    const { rows, nodes } = layoutBranches(commits, [local("main", "c", true), local("old-spike", "zzz")]);

    expect(rows.map((r) => r.name)).toEqual(["main", "old-spike"]);
    expect(nodes.every((n) => n.row === 0)).toBe(true);
  });

  it("hides a remote branch that has a local copy and keeps remote-only ones", () => {
    const commits = [commit("a", [], true)];
    const { rows } = layoutBranches(commits, [
      local("main", "a", true),
      remote("origin/main", "a"),
      remote("origin/release", "a"),
    ]);

    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(["current:main", "remote:origin/release"]);
  });

  it("labels a detached HEAD as its own row", () => {
    const commits = [commit("h", [], true)];
    const { rows } = layoutBranches(commits, []);

    expect(rows).toEqual([{ name: "HEAD", sha: "h", kind: "current", colorIndex: -1 }]);
  });
});
