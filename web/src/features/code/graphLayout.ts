import type { GitBranch, GitCommit } from "@octopus/shared";

/**
 * One row of the graph, drawn as its own track. The current branch is first, then the other local branches,
 * then remote branches that have no local copy. colorIndex is -1 for the current row.
 */
export type GraphRow = {
  name: string;
  sha: string;
  kind: "current" | "branch" | "remote";
  colorIndex: number;
};
/** A commit on its branch's row. Column 0 is the newest commit in the loaded history. */
export type Placed = { sha: string; col: number; row: number };
/** A line from a commit to one of its parents. The parent is older, so it sits further along the timeline. */
export type Link = { from: Placed; to: Placed };
export type GraphLayout = { rows: GraphRow[]; nodes: Placed[]; links: Link[] };

/**
 * Places every loaded commit on a row. A branch owns the commits on its first-parent line, starting at its tip,
 * and a commit belongs to the first row that reaches it. Commits reachable only through a second parent take the
 * row of their newest child. Commits and branches arrive newest first, as `git log` prints them.
 */
export function layoutBranches(commits: readonly GitCommit[], branches: readonly GitBranch[]): GraphLayout {
  const rows = branchRows(branches, commits.find((c) => c.head)?.sha);
  const bySha = new Map(commits.map((c, col) => [c.sha, { commit: c, col }]));
  const owner = new Map<string, number>();

  rows.forEach((row, r) => {
    let sha: string | undefined = row.sha;
    while (sha && bySha.has(sha) && !owner.has(sha)) {
      owner.set(sha, r);
      sha = bySha.get(sha)!.commit.parents[0];
    }
  });

  const childrenOf = new Map<string, string[]>();
  for (const commit of commits) {
    for (const parent of commit.parents) {
      if (bySha.has(parent)) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), commit.sha]);
    }
  }
  for (const commit of commits) {
    if (owner.has(commit.sha)) continue;
    const childRow = (childrenOf.get(commit.sha) ?? []).map((sha) => owner.get(sha)).find((r) => r !== undefined);
    owner.set(commit.sha, childRow ?? 0);
  }

  const nodes: Placed[] = commits.map((commit, col) => ({ sha: commit.sha, col, row: owner.get(commit.sha) ?? 0 }));
  const placed = new Map(nodes.map((node) => [node.sha, node]));
  const links: Link[] = [];
  for (const node of nodes) {
    for (const parent of commits[node.col]!.parents) {
      const to = placed.get(parent);
      if (to) links.push({ from: node, to });
    }
  }
  return { rows, nodes, links };
}

function branchRows(branches: readonly GitBranch[], headSha: string | undefined): GraphRow[] {
  const locals = branches.filter((b) => b.kind === "branch");
  const localNames = new Set(locals.map((b) => b.name));
  const current = locals.find((b) => b.current);
  const others = locals.filter((b) => !b.current).sort((a, b) => a.name.localeCompare(b.name));
  const remoteOnly = branches
    .filter((b) => b.kind === "remote" && !localNames.has(b.name.slice(b.name.indexOf("/") + 1)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const rows: GraphRow[] = [];
  if (current) rows.push({ name: current.name, sha: current.sha, kind: "current", colorIndex: -1 });
  else if (headSha) rows.push({ name: "HEAD", sha: headSha, kind: "current", colorIndex: -1 });
  others.forEach((b, i) => rows.push({ name: b.name, sha: b.sha, kind: "branch", colorIndex: i }));
  remoteOnly.forEach((b, i) => rows.push({ name: b.name, sha: b.sha, kind: "remote", colorIndex: others.length + i }));
  return rows;
}
