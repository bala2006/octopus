import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Send, Square, Terminal, Trash2, X } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { DevServerPanel } from "./DevServerPanel";

export function CommandPanel({
  workspace,
  onClose,
  onComplete,
  onPreview,
  initialMode = "commands",
  height = 256,
  visible = true,
}: {
  workspace: string;
  onClose: () => void;
  onComplete: () => void;
  onPreview: (url: string) => void;
  initialMode?: "commands" | "server";
  height?: number;
  visible?: boolean;
}) {
  const [mode, setMode] = React.useState<"commands" | "server">(initialMode);
  React.useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  const [command, setCommand] = React.useState("");
  const [stdin, setStdin] = React.useState("");
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const [error, setError] = React.useState("");
  const [following, setFollowing] = React.useState(true);
  const scroll = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const previousStatus = React.useRef<string>();
  const qc = useQueryClient();
  const key = ["command-task", workspace];
  const params = { path: { workspace_id: workspace } };
  const current = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/commands/current", { params }),
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 500 : 3000,
  });
  const started = useMutation({
    mutationFn: (text: string) =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/commands/current", {
          params,
          body: { command: text, timeout_seconds: 3600 },
        }),
      ),
    onMutate: async () => {
      setError("");
      await qc.cancelQueries({ queryKey: key });
    },
    onSuccess: (result, submitted) => {
      qc.setQueryData(key, result);
      setCommand("");
      setStdin("");
      setHistoryIndex(-1);
      setHistory((previous) => [...previous.slice(-49), submitted]);
      setFollowing(true);
    },
    onError: (e) => setError(e.message),
  });
  const stopped = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/w/{workspace_id}/editor/commands/current", {
          params,
        }),
      ),
    onSuccess: (result) => {
      qc.setQueryData(key, result);
      onComplete();
    },
    onError: (e) => setError(e.message),
  });
  const cleared = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/api/v1/w/{workspace_id}/editor/commands/output", {
          params,
        }),
      ),
    onSuccess: (result) => {
      qc.setQueryData(key, result);
      setError("");
    },
    onError: (e) => setError(e.message),
  });
  const sent = useMutation({
    mutationFn: (text: string) =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/commands/input", {
          params,
          body: { text },
        }),
      ),
    onSuccess: (_, submitted) => {
      setStdin((value) => (value === submitted ? "" : value));
      setError("");
    },
    onError: (e) => setError(e.message),
  });
  const running = current.data?.status === "running";
  const busy = running || started.isPending || stopped.isPending;
  React.useEffect(() => {
    if (
      current.data?.status === "exited" &&
      previousStatus.current !== "exited"
    ) {
      onComplete();
      if (visible && mode === "commands") input.current?.focus();
    }
    previousStatus.current = current.data?.status;
  }, [current.data?.status, onComplete, visible, mode]);
  React.useEffect(() => {
    if (following)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [current.data?.output, following]);
  const run = () => {
    if (command.trim() && !busy) started.mutate(command.trim());
  };
  return (
    <section
      aria-label="Project commands"
      className="flex min-h-0 shrink-0 flex-col border-t bg-background"
      style={{ height, maxHeight: "55dvh" }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-surface/50 px-3 text-xs">
        <Terminal className="h-3.5 w-3.5 text-steel" />
        <Button
          size="xs"
          variant={mode === "commands" ? "secondary" : "ghost"}
          aria-pressed={mode === "commands"}
          onClick={() => setMode("commands")}
        >
          Commands
        </Button>
        <Button
          size="xs"
          variant={mode === "server" ? "secondary" : "ghost"}
          aria-pressed={mode === "server"}
          onClick={() => setMode("server")}
        >
          Dev server
        </Button>
        {running && (
          <span
            role="status"
            className="flex items-center gap-1 text-[10px] text-success"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
            Running
          </span>
        )}
        <span className="hidden text-[11px] text-muted-foreground xl:inline">
          Live output · project folder
        </span>
        <div className="ml-auto flex">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Clear command output"
            disabled={busy || mode === "server" || cleared.isPending}
            onClick={() => cleared.mutate()}
          >
            <Trash2 />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Hide commands"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 flex-col",
          mode === "commands" ? "flex" : "hidden",
        )}
      >
        {error && (
          <p
            role="alert"
            className="border-b px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {current.isError && (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {current.error.message}
          </p>
        )}
        <div
          ref={scroll}
          onScroll={(e) => {
            const panel = e.currentTarget;
            setFollowing(
              panel.scrollHeight - panel.scrollTop - panel.clientHeight < 40,
            );
          }}
          className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
        >
          {!current.data || current.data.status === "idle" ? (
            <p className="text-muted-foreground">
              Run a build, test, or Git command. Output streams here and
              survives navigation. Commands have a one-hour limit; use Dev
              server for a persistent preview.
            </p>
          ) : (
            <>
              <p className="mb-1 font-semibold">› {current.data.command}</p>
              <pre
                className={cn(
                  "whitespace-pre-wrap break-words text-[11px]",
                  current.data.status === "exited" &&
                    current.data.exit_code !== 0
                    ? "text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {current.data.output || (running ? "Starting…" : "No output.")}
                {current.data.status === "exited" &&
                  `\n[${current.data.timed_out ? "Timed out" : `Exit ${current.data.exit_code}`}]`}
              </pre>
              {current.data.truncated && (
                <p className="mt-2 text-[10px] text-warning">
                  Older output removed. Showing the latest 24,000 characters.
                </p>
              )}
            </>
          )}
        </div>
        {!following && (
          <button
            className="border-t py-1 text-[11px] text-primary hover:bg-accent"
            onClick={() => setFollowing(true)}
          >
            Jump to latest output
          </button>
        )}
        {running && (
          <form
            className="flex shrink-0 gap-2 border-t px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              sent.mutate(stdin);
            }}
          >
            <Input
              aria-label="Command input"
              placeholder="Answer a prompt, then Send (Enter)…"
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              maxLength={16000}
              disabled={sent.isPending}
              className="h-8 min-w-0 font-mono text-xs"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              aria-label="Send command input"
              disabled={sent.isPending}
              loading={sent.isPending}
            >
              <Send />
              Send
            </Button>
            <Button
              size="sm"
              variant="destructive"
              type="button"
              aria-label="Stop command"
              disabled={stopped.isPending}
              loading={stopped.isPending}
              onClick={() => stopped.mutate()}
            >
              <Square />
              Stop
            </Button>
          </form>
        )}
        <form
          className="flex shrink-0 gap-2 border-t px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <Input
            ref={input}
            autoFocus
            aria-label="Project command"
            placeholder="npm run build, python -m pytest, git status…"
            value={command}
            disabled={busy}
            onChange={(e) => setCommand(e.target.value)}
            className="h-8 min-w-0 font-mono text-xs"
            maxLength={4000}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const index = Math.min(historyIndex + 1, history.length - 1);
                setHistoryIndex(index);
                setCommand(history[history.length - 1 - index]);
              }
              if (e.key === "ArrowDown" && historyIndex >= 0) {
                e.preventDefault();
                const index = historyIndex - 1;
                setHistoryIndex(index);
                setCommand(
                  index < 0 ? "" : history[history.length - 1 - index],
                );
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            disabled={busy || !command.trim()}
            loading={started.isPending}
          >
            <Play />
            Run
          </Button>
        </form>
      </div>
      {mode === "server" && (
        <DevServerPanel workspace={workspace} onPreview={onPreview} />
      )}
    </section>
  );
}
