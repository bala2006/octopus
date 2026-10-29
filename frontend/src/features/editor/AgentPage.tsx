import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  FileCode2,
  FolderOpen,
  GitBranch,
  Network,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useWorkspace, useWorkspaceId } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AgentPanel } from "./AgentPanel";

export default function AgentPage() {
  const w = useWorkspaceId();
  const workspace = useWorkspace(w);
  const tree = useQuery({
    queryKey: ["editor-tree", w],
    enabled: !!w,
    refetchInterval: 4000,
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/tree", {
          params: { path: { workspace_id: w } },
        }),
      ),
  });
  const navigate = useNavigate();
  const [context, setContext] = React.useState(() => window.innerWidth >= 1440);
  React.useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContext(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const files = tree.data?.files ?? [];
  return (
    <div className="conversation-page">
      <div className="conversation-content">
        <AgentPanel
          workspace={w}
          files={files}
          presentation="conversation"
          onOpen={(path) =>
            navigate(`/w/${w}/workspace?file=${encodeURIComponent(path)}`)
          }
          onClose={() => navigate(`/w/${w}/workspace`)}
        />
      </div>
      <Button
        className="conversation-context-toggle"
        variant="ghost"
        size="icon"
        aria-label={context ? "Hide project details" : "Show project details"}
        aria-expanded={context}
        onClick={() => setContext(!context)}
      >
        {context ? <PanelRightClose /> : <PanelRightOpen />}
      </Button>
      {context && (
        <aside className="conversation-context" aria-label="Project details">
          <div className="context-card">
            <p className="text-xs text-muted-foreground">Project</p>
            <h2 className="mt-3 flex items-center gap-2 text-sm font-medium">
              <FolderOpen className="h-4 w-4" />
              {workspace.data?.name}
            </h2>
            <p className="mt-2 break-all text-xs leading-relaxed text-muted-foreground">
              {workspace.data?.display_path || workspace.data?.path}
            </p>
            <Link
              to={`/w/${w}/workspace?tool=git`}
              className="context-card-link"
            >
              <GitBranch />
              Review changes
            </Link>
            <Link to={`/w/${w}/workspace`} className="context-card-link">
              <FileCode2 />
              Open workspace
            </Link>
            <Link to={`/w/${w}/canvas`} className="context-card-link">
              <Network />
              Manage your team
            </Link>
          </div>
          <p className="mt-5 px-1 text-xs leading-relaxed text-muted-foreground">
            Your team's replies, file changes, and requests for approval appear
            in the conversation.
          </p>
        </aside>
      )}
    </div>
  );
}
