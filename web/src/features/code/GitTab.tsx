import { useWorkspaceId } from "@/hooks/queries";
import { GitPanel } from "./GitPanel";

/**
 * The Git changes tab: the branch graph, the changed files, each diff, staging, and commit.
 * reserveRight keeps the tab clear of the floating chat when the chat is docked on the right.
 */
export function GitTab({ onOpen, reserveRight = 0 }: { onOpen: (path: string) => void; reserveRight?: number }) {
  const workspace = useWorkspaceId();
  return (
    <div className="conversation-page-tab" style={{ paddingRight: reserveRight }}>
      <GitPanel workspace={workspace} onOpen={onOpen} />
    </div>
  );
}
