import { useWorkspaceId } from "@/hooks/queries";
import { GitPanel } from "./GitPanel";

/** The Git changes tab: the project's changed files, with each diff, staging, and commit. */
export function GitTab({ onOpen }: { onOpen: (path: string) => void }) {
  const workspace = useWorkspaceId();
  return (
    <div className="conversation-page-tab">
      <GitPanel workspace={workspace} onOpen={onOpen} />
    </div>
  );
}
