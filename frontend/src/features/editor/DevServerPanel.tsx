import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Play, Square } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { parsePreviewAddress } from "./previewAddress";

export function DevServerPanel({
  workspace,
  onPreview,
}: {
  workspace: string;
  onPreview: (url: string) => void;
}) {
  const key = ["dev-server", workspace];
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/server", {
          params: { path: { workspace_id: workspace } },
        }),
      ),
    refetchInterval: 1000,
  });
  const [command, setCommand] = React.useState("");
  const [address, setAddress] = React.useState("localhost:3000");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const output = React.useRef<HTMLPreElement>(null);
  const running = query.data?.status === "running";
  React.useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [query.data?.output]);
  const change = async (stop: boolean) => {
    setBusy(true);
    setError("");
    try {
      const params = { path: { workspace_id: workspace } };
      const data = stop
        ? await unwrap(
            api.DELETE("/api/v1/w/{workspace_id}/editor/server", { params }),
          )
        : await unwrap(
            api.POST("/api/v1/w/{workspace_id}/editor/server", {
              params,
              body: { command: command.trim() },
            }),
          );
      qc.setQueryData(key, data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Server operation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex flex-wrap items-center gap-2 border-b px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void change(false);
        }}
      >
        <Input
          aria-label="Development server command"
          className="h-8 min-w-40 flex-1 font-mono text-xs"
          placeholder="npm run dev -- --host 127.0.0.1"
          value={running ? (query.data?.command ?? command) : command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={running || busy}
          maxLength={4000}
        />
        {running ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            loading={busy}
            onClick={() => void change(true)}
          >
            <Square />
            Stop server
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            loading={busy}
            disabled={!command.trim() || busy || query.isLoading}
          >
            <Play />
            Start server
          </Button>
        )}
        <Input
          aria-label="Development server address"
          className="h-8 w-40 text-xs"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!running}
          onClick={() => {
            try {
              onPreview(parsePreviewAddress(address));
              setError("");
            } catch {
              setError("Enter a valid http:// or https:// preview address.");
            }
          }}
        >
          <Globe />
          Open preview
        </Button>
      </form>
      {(error || query.isError) && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error || query.error?.message}
        </p>
      )}
      <div
        role="status"
        className="flex shrink-0 items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-success" : "bg-muted-foreground"}`}
        />
        {running
          ? "Running · stays active when you leave this page"
          : query.data?.status === "exited"
            ? `Stopped · exit ${query.data.exit_code}`
            : "Start your app's development server. Use a loopback address such as 127.0.0.1."}
        {query.data?.truncated && <span>· Showing latest output</span>}
      </div>
      <pre
        ref={output}
        aria-label="Development server output"
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] text-muted-foreground"
      >
        {query.data?.output || "Server output will appear here."}
      </pre>
    </div>
  );
}
