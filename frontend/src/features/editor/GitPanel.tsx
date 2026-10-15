import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, GitBranch, RefreshCw } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import type { components } from "@/types/api.gen";
import { toast } from "sonner";

type GitFile = components["schemas"]["GitFile"];

export function GitPanel({
  workspace,
  onOpen,
}: {
  workspace: string;
  onOpen: (path: string) => void;
}) {
  const [file, setFile] = React.useState<GitFile | null>(null);
  const reviewedPath = React.useRef<string | null>(null);
  const [staged, setStaged] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [commitError, setCommitError] = React.useState("");
  const qc = useQueryClient();
  const params = { path: { workspace_id: workspace } };
  const status = useQuery({
    queryKey: ["git-status", workspace],
    queryFn: () =>
      unwrap(api.GET("/api/v1/w/{workspace_id}/editor/git", { params })),
    refetchInterval: 5000,
    retry: false,
  });
  const diff = useQuery({
    queryKey: ["git-diff", workspace, file?.path, staged],
    enabled: !!file,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/git/diff", {
          params: { ...params, query: { path: file?.path ?? "", staged } },
        }),
      ),
    retry: false,
  });
  const stagedFiles =
    status.data?.files.filter(
      (f) => f.status !== "??" && f.status[0] !== " ",
    ) ?? [];
  const commit = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/git/commit", {
          params,
          body: {
            message: message.trim(),
            expected_index: status.data!.index_revision,
          },
        }),
      ),
    onMutate: () => setCommitError(""),
    onSuccess: (result) => {
      qc.setQueryData(["git-status", workspace], result.status);
      void qc.invalidateQueries({ queryKey: ["git-diff", workspace] });
      setMessage("");
      reviewedPath.current = null;
      setFile(null);
      toast.success(`Committed ${result.commit_sha.slice(0, 7)}`);
    },
    onError: (e: Error) => {
      setCommitError(e.message);
      void status.refetch();
    },
  });
  const setStage = async (staging: boolean) => {
    if (!file) return;
    const path = file.path;
    setBusy(true);
    try {
      const data = await unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/git/stage", {
          params,
          body: { path, staged: staging },
        }),
      );
      qc.setQueryData(["git-status", workspace], data);
      if (reviewedPath.current === path) {
        setFile((selected) =>
          selected?.path === path
            ? (data.files.find((f) => f.path === path) ?? null)
            : selected,
        );
        setStaged(staging);
      }
      void qc.invalidateQueries({ queryKey: ["git-diff", workspace] });
      toast.success(staging ? "File staged" : "File unstaged");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Git operation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-steel" />
        <span className="truncate">
          {status.data?.branch ?? "Source control"}
        </span>
        <Button
          className="ml-auto"
          size="icon"
          variant="ghost"
          aria-label="Refresh Git changes"
          onClick={() => void status.refetch()}
        >
          <RefreshCw className={status.isFetching ? "animate-spin" : ""} />
        </Button>
      </div>
      {status.data && (
        <form
          className="space-y-2 border-b p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim() && stagedFiles.length && !commit.isPending)
              commit.mutate();
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
            disabled={
              !message.trim() || !stagedFiles.length || commit.isPending || busy
            }
            loading={commit.isPending}
          >
            Commit staged{stagedFiles.length ? ` (${stagedFiles.length})` : ""}
          </Button>
          {commitError && (
            <p role="alert" className="text-[11px] text-destructive">
              {commitError}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">
            Review and stage files below. Use Commands for hooks or signed
            commits.
          </p>
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {status.isLoading && (
          <p className="p-3 text-xs text-muted-foreground">
            Reading Git changes…
          </p>
        )}
        {status.isError && (
          <div className="p-3 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">
              Git review is unavailable
            </p>
            <p className="mt-2">{status.error.message}</p>
            <p className="mt-2">
              Open a Git repository root with Git installed to review its
              changes.
            </p>
          </div>
        )}
        {status.data?.files.map((entry) => (
          <button
            key={entry.path}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-accent"
            title={entry.path}
            onClick={() => {
              reviewedPath.current = entry.path;
              setStaged(entry.status[0] !== " " && entry.status !== "??");
              setFile(entry);
            }}
          >
            <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.path}</span>
            <span className="ml-auto shrink-0 font-mono text-primary">
              {entry.status.trim()}
            </span>
          </button>
        ))}
        {status.data && !status.data.files.length && (
          <p className="p-3 text-xs text-muted-foreground">
            Working tree clean. No visible changes.
          </p>
        )}
      </div>
      <p className="border-t p-3 text-[10px] text-muted-foreground">
        Review and stage individual files. Use Commands or your Git client to
        commit with repository hooks or signing.
      </p>
      <Dialog
        open={!!file}
        onOpenChange={(open) => {
          if (!open) {
            reviewedPath.current = null;
            setFile(null);
          }
        }}
      >
        <DialogContent className="flex h-[80vh] max-w-5xl flex-col overflow-hidden">
          <DialogTitle className="truncate pr-6">{file?.path}</DialogTitle>
          <DialogDescription>
            {file?.original_path
              ? `Renamed from ${file.original_path}`
              : "Review the Git patch before continuing your work."}
          </DialogDescription>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={!staged ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={!staged}
              onClick={() => setStaged(false)}
            >
              Working changes
            </Button>
            <Button
              variant={staged ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={staged}
              onClick={() => setStaged(true)}
            >
              Staged changes
            </Button>
            <Button
              className="ml-auto"
              size="sm"
              variant="outline"
              disabled={file?.status.includes("D")}
              onClick={() => {
                if (file) onOpen(file.path);
                reviewedPath.current = null;
                setFile(null);
              }}
            >
              Open file
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={busy}
              disabled={
                busy || (file?.status[1] === " " && file?.status !== "??")
              }
              onClick={() => void setStage(true)}
            >
              Stage file
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy || !file || file.status[0] === " " || file.status === "??"
              }
              onClick={() => void setStage(false)}
            >
              Unstage file
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-background p-3 font-mono text-xs">
            {diff.isFetching ? (
              <p>Loading patch…</p>
            ) : diff.isError ? (
              <p role="alert" className="text-destructive">
                {diff.error.message}
              </p>
            ) : diff.data?.patch ? (
              <pre>
                {diff.data.patch.split("\n").map((line, i) => (
                  <span
                    key={i}
                    className={cn(
                      "block min-h-4",
                      line.startsWith("+")
                        ? "bg-success/10 text-success"
                        : line.startsWith("-")
                          ? "bg-destructive/10 text-destructive"
                          : line.startsWith("@@")
                            ? "text-steel"
                            : "text-muted-foreground",
                    )}
                  >
                    {line}
                  </span>
                ))}
              </pre>
            ) : (
              <p className="font-sans text-sm text-muted-foreground">
                {file?.status === "??"
                  ? "This file is untracked. Open it to inspect its contents."
                  : "No changes in this view. Try the other changes tab."}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
