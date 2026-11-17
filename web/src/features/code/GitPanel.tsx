import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FileCode2, GitBranch, Minus, Plus, RefreshCw } from "lucide-react";
import type { GitBranch as RepoBranch, GitFile } from "@octopus/shared";
import { toast } from "sonner";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { GitDiff } from "./GitDiff";
import { CommitDetails, GitGraph } from "./GitGraph";

/** Git status for one workspace. The Files tab and the Git tab share this query. */
export function useGitStatus(workspace: string) {
  return useQuery({
    queryKey: ["git-status", workspace],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/git", {
          params: { path: { workspace_id: workspace } },
        }),
      ),
    refetchInterval: 5000,
    retry: false,
  });
}

/** Recent commits for the graph, refreshed on the same schedule as the status. */
export function useGitLog(workspace: string) {
  return useQuery({
    queryKey: ["git-log", workspace],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/git/log", {
          params: { path: { workspace_id: workspace } },
        }),
      ),
    refetchInterval: 5000,
    retry: false,
  });
}

/** A file can sit in two lists at once: staged, and edited again after staging. */
type Side = "staged" | "unstaged" | "untracked";
type Change = { path: string; side: Side };
type Selection = ({ kind: "change" } & Change) | { kind: "commit"; sha: string } | null;

const isStaged = (f: GitFile) => f.status !== "??" && f.status.charAt(0) !== " ";
const isUnstaged = (f: GitFile) => f.status !== "??" && f.status.charAt(1) !== " ";
const isUntracked = (f: GitFile) => f.status === "??";

const LETTER_TONE: Record<string, string> = {
  M: "text-warning",
  A: "text-success",
  U: "text-success",
  D: "text-destructive",
  R: "text-sky-400",
  C: "text-sky-400",
};
const SIDE_LABEL: Record<Side, string> = { staged: "Staged", unstaged: "Changes", untracked: "Untracked" };
const NO_BRANCHES: RepoBranch[] = [];

export function GitPanel({
  workspace,
  onOpen,
}: {
  workspace: string;
  onOpen: (path: string) => void;
}) {
  const qc = useQueryClient();
  const params = { path: { workspace_id: workspace } };
  const status = useGitStatus(workspace);
  const log = useGitLog(workspace);
  const [selection, setSelection] = React.useState<Selection>(null);
  const [message, setMessage] = React.useState("");
  const [commitError, setCommitError] = React.useState("");
  const files = status.data?.files ?? [];
  const staged = files.filter(isStaged);
  const unstaged = files.filter(isUnstaged);
  const untracked = files.filter(isUntracked);
  const change = selection?.kind === "change" ? selection : null;
  const selectedCommit =
    selection?.kind === "commit" ? log.data?.commits.find((c) => c.sha === selection.sha) : undefined;

  const diff = useQuery({
    queryKey: ["git-diff", workspace, change?.path ?? "", change?.side ?? ""],
    enabled: !!change,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/git/diff", {
          params: {
            ...params,
            query: { path: change?.path ?? "", staged: change?.side === "staged" },
          },
        }),
      ),
    retry: false,
  });

  const stage = useMutation({
    mutationFn: ({ path, staged: next }: { path: string; staged: boolean }) =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/git/stage", {
          params,
          body: { path, staged: next },
        }),
      ),
    onSuccess: (data, vars) => {
      qc.setQueryData(["git-status", workspace], data);
      void qc.invalidateQueries({ queryKey: ["git-diff", workspace] });
      setSelection((current) => {
        if (current?.kind !== "change" || current.path !== vars.path) return current;
        const after = data.files.find((f) => f.path === vars.path);
        if (!after) return null;
        const side: Side = isUntracked(after) ? "untracked" : vars.staged ? "staged" : "unstaged";
        return { kind: "change", path: vars.path, side };
      });
      toast.success(vars.staged ? "File staged" : "File unstaged");
    },
    onError: (e: Error) => toast.error(e.message || "Git operation failed"),
  });

  const commit = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/git/commit", {
          params,
          body: {
            message: message.trim(),
            expected_index: status.data?.index_revision ?? "",
          },
        }),
      ),
    onMutate: () => setCommitError(""),
    onSuccess: (result) => {
      qc.setQueryData(["git-status", workspace], result.status);
      void qc.invalidateQueries({ queryKey: ["git-diff", workspace] });
      void qc.invalidateQueries({ queryKey: ["git-log", workspace] });
      setMessage("");
      setSelection({ kind: "commit", sha: result.commit_sha });
      toast.success(`Committed ${result.commit_sha.slice(0, 7)}`);
    },
    onError: (e: Error) => {
      setCommitError(e.message);
      void status.refetch();
    },
  });

  const refresh = () => {
    void status.refetch();
    void log.refetch();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-steel" aria-hidden="true" />
        <span className="font-semibold">{status.data?.branch ?? "Source control"}</span>
        {status.data && (
          <span className="text-muted-foreground">
            {files.length} changed · {log.data?.commits.length ?? 0} recent commits
          </span>
        )}
        <Button
          className="ml-auto"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh Git changes"
          onClick={refresh}
        >
          <RefreshCw className={status.isFetching || log.isFetching ? "animate-spin" : ""} />
        </Button>
      </div>
      {status.isError ? (
        <div className="p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Git review is unavailable</p>
          <p className="mt-2">{status.error.message}</p>
          <p className="mt-2">Open a Git repository root with Git installed to review its changes.</p>
        </div>
      ) : (
        <>
          <GitGraph
            commits={log.data?.commits ?? []}
            branches={log.data?.branches ?? NO_BRANCHES}
            workingCount={files.length}
            selected={selection?.kind === "commit" ? selection.sha : null}
            onSelect={(sha) => setSelection({ kind: "commit", sha })}
          />
          <div className="flex min-h-0 flex-1">
            <aside className="flex w-[300px] shrink-0 flex-col border-r">
              {status.data && (
                <form
                  className="space-y-2 border-b p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (message.trim() && staged.length && !commit.isPending) commit.mutate();
                  }}
                >
                  <Input
                    aria-label="Commit message"
                    placeholder="Commit message"
                    value={message}
                    maxLength={5000}
                    onChange={(e) => setMessage(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    className="w-full"
                    disabled={!message.trim() || !staged.length || commit.isPending}
                    loading={commit.isPending}
                  >
                    Commit {staged.length} staged {staged.length === 1 ? "change" : "changes"}
                  </Button>
                  {commitError && (
                    <p role="alert" className="text-[11px] text-destructive">
                      {commitError}
                    </p>
                  )}
                </form>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {status.isLoading && (
                  <p className="p-3 text-xs text-muted-foreground">Reading Git changes…</p>
                )}
                <ChangeGroup
                  title={SIDE_LABEL.staged}
                  side="staged"
                  files={staged}
                  selected={change}
                  busy={stage.isPending}
                  onSelect={(path) => setSelection({ kind: "change", path, side: "staged" })}
                  onStage={(path, next) => stage.mutate({ path, staged: next })}
                  onOpen={onOpen}
                />
                <ChangeGroup
                  title={SIDE_LABEL.unstaged}
                  side="unstaged"
                  files={unstaged}
                  selected={change}
                  busy={stage.isPending}
                  onSelect={(path) => setSelection({ kind: "change", path, side: "unstaged" })}
                  onStage={(path, next) => stage.mutate({ path, staged: next })}
                  onOpen={onOpen}
                />
                <ChangeGroup
                  title={SIDE_LABEL.untracked}
                  side="untracked"
                  files={untracked}
                  selected={change}
                  busy={stage.isPending}
                  onSelect={(path) => setSelection({ kind: "change", path, side: "untracked" })}
                  onStage={(path, next) => stage.mutate({ path, staged: next })}
                  onOpen={onOpen}
                />
                {status.data && !files.length && (
                  <p className="p-3 text-xs text-muted-foreground">Working tree clean. Nothing to commit.</p>
                )}
              </div>
            </aside>
            <section className="min-w-0 flex-1 overflow-auto">
              {selectedCommit ? (
                <CommitDetails commit={selectedCommit} branches={log.data?.branches ?? NO_BRANCHES} />
              ) : change ? (
                <ChangeView
                  change={change}
                  file={files.find((f) => f.path === change.path)}
                  diff={diff}
                  busy={stage.isPending}
                  onStage={(path, next) => stage.mutate({ path, staged: next })}
                  onOpen={onOpen}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-8 text-center text-xs leading-relaxed text-muted-foreground">
                  <p className="max-w-sm">
                    Select a commit in the graph to see its details, or a change on the left to review its diff.
                  </p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function ChangeGroup({
  title,
  side,
  files,
  selected,
  busy,
  onSelect,
  onStage,
  onOpen,
}: {
  title: string;
  side: Side;
  files: GitFile[];
  selected: Change | null;
  busy: boolean;
  onSelect: (path: string) => void;
  onStage: (path: string, staged: boolean) => void;
  onOpen: (path: string) => void;
}) {
  if (!files.length) return null;
  return (
    <section className="mb-1">
      <h3 className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title} · {files.length}
      </h3>
      {files.map((file) => (
        <ChangeRow
          key={`${side}:${file.path}`}
          file={file}
          side={side}
          selected={selected?.path === file.path && selected.side === side}
          busy={busy}
          onSelect={() => onSelect(file.path)}
          onStage={onStage}
          onOpen={onOpen}
        />
      ))}
    </section>
  );
}

function ChangeRow({
  file,
  side,
  selected,
  busy,
  onSelect,
  onStage,
  onOpen,
}: {
  file: GitFile;
  side: Side;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onStage: (path: string, staged: boolean) => void;
  onOpen: (path: string) => void;
}) {
  const slash = file.path.lastIndexOf("/");
  const name = file.path.slice(slash + 1);
  const folder = slash === -1 ? "" : file.path.slice(0, slash);
  const letter = side === "untracked" ? "U" : side === "staged" ? file.status.charAt(0) : file.status.charAt(1);
  const stagesNow = side !== "staged";
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-md pr-1 text-xs transition-colors hover:bg-accent",
        selected && "bg-accent",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        title={file.path}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left"
      >
        <span className={cn("w-3 shrink-0 text-center font-mono text-[11px] font-semibold", LETTER_TONE[letter] ?? "text-muted-foreground")}>
          {letter}
        </span>
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate">{name}</span>
        {folder && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{folder}</span>}
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`${stagesNow ? "Stage" : "Unstage"} ${file.path}`}
        title={stagesNow ? "Stage" : "Unstage"}
        disabled={busy}
        onClick={() => onStage(file.path, stagesNow)}
      >
        {stagesNow ? <Plus /> : <Minus />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        aria-label={`Open ${file.path} in Files`}
        title="Open in Files"
        disabled={file.status.includes("D")}
        onClick={() => onOpen(file.path)}
      >
        <ExternalLink />
      </Button>
    </div>
  );
}

function ChangeView({
  change,
  file,
  diff,
  busy,
  onStage,
  onOpen,
}: {
  change: Change;
  file: GitFile | undefined;
  diff: { data?: { patch: string }; isFetching: boolean; error: Error | null };
  busy: boolean;
  onStage: (path: string, staged: boolean) => void;
  onOpen: (path: string) => void;
}) {
  const stagesNow = change.side !== "staged";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-xs">
        <span className="min-w-0 truncate font-medium" title={change.path}>
          {change.path}
        </span>
        <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          {SIDE_LABEL[change.side]}
        </span>
        {file?.original_path && <span className="truncate text-muted-foreground">from {file.original_path}</span>}
        <div className="ml-auto flex shrink-0 gap-2">
          <Button
            size="sm"
            variant={stagesNow ? "default" : "outline"}
            disabled={busy || !file}
            onClick={() => onStage(change.path, stagesNow)}
          >
            {stagesNow ? "Stage file" : "Unstage file"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!file || file.status.includes("D")}
            onClick={() => onOpen(change.path)}
          >
            Open file
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <GitDiff
          patch={diff.data?.patch}
          loading={diff.isFetching}
          error={diff.error ? diff.error.message : undefined}
          untracked={change.side === "untracked"}
        />
      </div>
    </div>
  );
}
