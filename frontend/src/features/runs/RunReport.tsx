import { useQuery } from "@tanstack/react-query";
import { fetchRaw } from "@/lib/api";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";

export function ReportView({ w, runId, enabled }: { w: string; runId: string; enabled: boolean }) {
  const query = useQuery({ queryKey: ["report", w, runId], enabled,
    queryFn: async () => (await fetchRaw(`/api/v1/w/${w}/runs/${runId}/report`)).text() });
  if (!enabled) return <p className="p-6 text-sm text-muted-foreground">The report appears when the conversation reaches a stopping point.</p>;
  if (query.isPending) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading report…</p>;
  if (query.isError) return <div role="alert" className="space-y-3 p-4 text-sm"><p>The report could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button></div>;
  return <div className="p-4"><Markdown>{query.data}</Markdown></div>;
}
