import * as React from "react";
import type { GitBranch, GitCommit } from "@octopus/shared";
import { cn } from "@/lib/utils";
import { layoutBranches, type GraphRow } from "./graphLayout";

const COL_W = 64;
const ROW_H = 34;
const PAD = 28;
const NODE_R = 5;
const WORKING_W = 120;
const CURRENT_COLOR = "#60a5fa";
const PALETTE = ["#34d399", "#f472b6", "#fbbf24", "#a78bfa", "#fb923c", "#22d3ee", "#f87171", "#a3e635"];

const rowColor = (row: GraphRow) =>
  row.kind === "current" ? CURRENT_COLOR : (PALETTE[row.colorIndex % PALETTE.length] ?? CURRENT_COLOR);

/**
 * The branch graph: one row per branch, so every branch is visible at once. The current branch has one color and
 * every other branch has its own. Time runs left to right, so the newest commit sits at the right end.
 */
export function GitGraph({
  commits,
  branches,
  workingCount,
  selected,
  onSelect,
}: {
  commits: GitCommit[];
  branches: GitBranch[];
  workingCount: number;
  selected: string | null;
  onSelect: (sha: string) => void;
}) {
  const { rows, nodes, links } = React.useMemo(() => layoutBranches(commits, branches), [commits, branches]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const cols = commits.length;
  const headCol = commits.findIndex((c) => c.head);
  const headNode = headCol === -1 ? undefined : nodes[headCol];
  const showWorking = workingCount > 0 && !!headNode;
  const xOf = (col: number) => PAD + (cols - 1 - col) * COL_W;
  const yOf = (row: number) => ROW_H / 2 + row * ROW_H;
  const colorAt = (row: number) => {
    const found = rows[row];
    return found ? rowColor(found) : CURRENT_COLOR;
  };
  const height = Math.max(1, rows.length) * ROW_H;
  const occupied = new Set(nodes.map((n) => n.row));
  const width = cols ? xOf(showWorking ? -1 : 0) + PAD + (showWorking ? WORKING_W : 0) : 0;

  React.useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [width]);

  if (!cols) {
    return (
      <p className="border-b px-4 py-6 text-center text-xs text-muted-foreground">
        No commits yet. The graph appears after your first commit.
      </p>
    );
  }

  return (
    <div className="flex max-h-[300px] shrink-0 overflow-y-auto border-b">
      <div className="relative w-44 shrink-0 border-r" style={{ height }}>
        {rows.map((row, r) => (
          <div
            key={`${row.kind}:${row.name}`}
            className="absolute inset-x-0 flex items-center gap-2 px-3 text-xs"
            style={{ top: r * ROW_H, height: ROW_H }}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorAt(r) }} aria-hidden="true" />
            <span
              className={cn(
                "truncate",
                row.kind === "current" ? "font-semibold text-foreground" : "text-muted-foreground",
                row.kind === "remote" && "opacity-70",
              )}
              title={row.name}
            >
              {row.name}
            </span>
          </div>
        ))}
      </div>
      <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
        <svg width={width} height={height} className="block" role="group" aria-label="Branch graph">
          {rows.map((row, r) => (
            <line
              key={`track:${row.kind}:${row.name}`}
              x1={PAD / 2}
              x2={width - PAD / 2}
              y1={yOf(r)}
              y2={yOf(r)}
              stroke={colorAt(r)}
              strokeOpacity={0.14}
              strokeWidth={1}
            />
          ))}
          {rows.map((row, r) =>
            occupied.has(r) ? null : (
              <text key={`older:${row.kind}:${row.name}`} x={PAD} y={yOf(r) + 4} fontSize={10} fontStyle="italic" className="fill-muted-foreground">
                older history not loaded
              </text>
            ),
          )}
          {links.map(({ from, to }) => {
            const x1 = xOf(from.col);
            const y1 = yOf(from.row);
            const x2 = xOf(to.col);
            const y2 = yOf(to.row);
            const mid = (x1 + x2) / 2;
            const d =
              from.row === to.row ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
            return (
              <path key={`${from.sha}>${to.sha}`} d={d} fill="none" stroke={colorAt(from.row)} strokeWidth={2} />
            );
          })}
          {showWorking && headNode && (
            <g>
              <line
                x1={xOf(headCol)}
                y1={yOf(headNode.row)}
                x2={xOf(-1)}
                y2={yOf(headNode.row)}
                strokeDasharray="4 4"
                strokeWidth={1.5}
                className="stroke-muted-foreground"
              />
              <circle
                cx={xOf(-1)}
                cy={yOf(headNode.row)}
                r={NODE_R}
                fill="none"
                strokeDasharray="2 3"
                strokeWidth={1.5}
                className="stroke-muted-foreground"
              />
              <text x={xOf(-1) + 11} y={yOf(headNode.row) + 4} fontSize={11} className="fill-muted-foreground">
                {workingCount} uncommitted
              </text>
            </g>
          )}
          {nodes.map((node) => {
            const commit = commits[node.col];
            if (!commit) return null;
            return (
              <CommitDot
                key={commit.sha}
                commit={commit}
                x={xOf(node.col)}
                y={yOf(node.row)}
                color={colorAt(node.row)}
                selected={commit.sha === selected}
                onSelect={onSelect}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function CommitDot({
  commit,
  x,
  y,
  color,
  selected,
  onSelect,
}: {
  commit: GitCommit;
  x: number;
  y: number;
  color: string;
  selected: boolean;
  onSelect: (sha: string) => void;
}) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${commit.subject}, ${commit.sha.slice(0, 7)}`}
      aria-pressed={selected}
      className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-ring"
      onClick={() => onSelect(commit.sha)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(commit.sha);
        }
      }}
    >
      <title>{`${commit.subject}\n${commit.author} · ${commit.sha.slice(0, 7)}`}</title>
      <circle cx={x} cy={y} r={NODE_R + 6} fill="transparent" />
      {selected && <circle cx={x} cy={y} r={NODE_R + 5} fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={2} />}
      {commit.head ? (
        <circle cx={x} cy={y} r={NODE_R + 2} fill="hsl(var(--background))" stroke={color} strokeWidth={2.5} />
      ) : (
        <circle cx={x} cy={y} r={NODE_R} fill={color} />
      )}
    </g>
  );
}

/** The selected commit: who wrote it, when, where it sits in history, and the branches and tags that point at it. */
export function CommitDetails({ commit, branches }: { commit: GitCommit; branches: GitBranch[] }) {
  const pointing = branches.filter((b) => b.sha === commit.sha);
  const tags = commit.refs.filter((r) => r.kind === "tag");
  return (
    <article className="space-y-5 p-6">
      <div>
        <p className="font-mono text-[11px] text-muted-foreground">{commit.sha.slice(0, 7)}</p>
        <h2 className="mt-1 text-base font-semibold leading-snug">{commit.subject}</h2>
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-xs">
        <dt className="text-muted-foreground">Author</dt>
        <dd>{commit.author}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd>{formatDate(commit.date)}</dd>
        <dt className="text-muted-foreground">Parents</dt>
        <dd className="font-mono">
          {commit.parents.length ? commit.parents.map((p) => p.slice(0, 7)).join(", ") : "None, this is the first commit"}
        </dd>
        <dt className="text-muted-foreground">Branches and tags</dt>
        <dd className="flex flex-wrap gap-1.5">
          {commit.head && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-primary">HEAD</span>}
          {pointing.map((b) => (
            <span key={`${b.kind}:${b.name}`} className="rounded-full border px-2 py-0.5">
              {b.name}
            </span>
          ))}
          {tags.map((t) => (
            <span key={`tag:${t.name}`} className="rounded-full border border-warning/40 px-2 py-0.5 text-warning">
              {t.name}
            </span>
          ))}
          {!commit.head && !pointing.length && !tags.length && <span className="text-muted-foreground">None</span>}
        </dd>
        <dt className="text-muted-foreground">Full hash</dt>
        <dd className="break-all font-mono text-[11px] text-muted-foreground">{commit.sha}</dd>
      </dl>
    </article>
  );
}

function formatDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
