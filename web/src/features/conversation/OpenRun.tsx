import * as React from "react";
import { useParams } from "react-router-dom";
import { Loader2, MessageSquare } from "lucide-react";
import { useRun, useWorkspaceId } from "@/hooks/queries";
import { EmptyState } from "@/components/common";
import { useOpenConversation } from "./useOpenConversation";

/** `/w/:wid/runs/:runId` (old links, notifications, bookmarks) opens that conversation in the Conversation space. */
export default function OpenRun() {
  const w = useWorkspaceId();
  const { runId = "" } = useParams();
  const run = useRun(w, runId);
  const open = useOpenConversation();
  React.useEffect(() => {
    if (run.data) open(w, run.data, undefined, true);
  }, [run.data, w, open]);
  if (run.isError) return <EmptyState icon={MessageSquare} title="Conversation not found" description={run.error.message} />;
  return <div className="flex h-full items-center justify-center" role="status"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /><span className="sr-only">Opening the conversation</span></div>;
}
