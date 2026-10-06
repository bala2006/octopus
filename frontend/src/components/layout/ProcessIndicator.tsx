import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Radio, Terminal } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { useWorkspaceId } from "@/hooks/queries";
import { Tip } from "@/components/ui/overlays";

export function ProcessIndicator() {
  const workspace = useWorkspaceId();
  const server = useQuery({
    queryKey: ["dev-server", workspace],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/server", {
          params: { path: { workspace_id: workspace } },
        }),
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 3000 : 10000,
  });
  const command = useQuery({
    queryKey: ["command-task", workspace],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/commands/current", {
          params: { path: { workspace_id: workspace } },
        }),
      ),
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 3000 : 10000,
  });
  return (
    <>
      {command.data?.status === "running" && (
        <Tip
          content={`Command running: ${command.data.command}. Return to its output, send input, or stop it.`}
          side="bottom"
        >
          <Link
            aria-label="Command running"
            to={`/w/${workspace}/workspace?tool=commands`}
            className="flex items-center gap-1.5 rounded-full border border-steel/40 bg-steel/10 px-2.5 py-1 text-[11px] font-medium text-steel transition-colors hover:bg-steel/20"
          >
            <Terminal className="h-3 w-3 animate-pulse" />
            <span className="hidden sm:inline">Command</span>
          </Link>
        </Tip>
      )}
      {server.data?.status === "running" && (
        <Tip
          content={`Development server running: ${server.data.command}. Open its controls to preview or stop it.`}
          side="bottom"
        >
          <Link
            aria-label="Development server running"
            to={`/w/${workspace}/workspace?tool=server`}
            className="flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success transition-colors hover:bg-success/20"
          >
            <Radio className="h-3 w-3 animate-pulse" />
            <span className="hidden sm:inline">Dev server</span>
          </Link>
        </Tip>
      )}
    </>
  );
}
