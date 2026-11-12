import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { fetchRaw } from "@/lib/api";
import { download } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";

/** Downloads a conversation's recap as Markdown. One file name everywhere. */
export async function downloadRecap(w: string, runId: string) {
  const res = await fetchRaw(`/api/v1/w/${w}/runs/${runId}/report?download=true`);
  download(`team-recap-${runId.slice(0, 8)}.md`, await res.text(), "text/markdown");
}

export function ReportView({ w, runId, enabled, downloadable = false }: { w: string; runId: string; enabled: boolean; downloadable?: boolean }) {
  const query = useQuery({ queryKey: ["report", w, runId], enabled,
    queryFn: async () => (await fetchRaw(`/api/v1/w/${w}/runs/${runId}/report`)).text() });
  if (!enabled) return <p className="p-6 text-sm text-muted-foreground">The recap appears when the team reaches a stopping point.</p>;
  if (query.isPending) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading the recap…</p>;
  if (query.isError) return <div role="alert" className="space-y-3 p-4 text-sm"><p>The recap could not be loaded.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Try again</Button></div>;
  return (
    <div className="p-4">
      {downloadable && <div className="mb-2 flex justify-end"><Button size="xs" variant="ghost" onClick={() => void downloadRecap(w, runId)}><Download />Download Markdown</Button></div>}
      <Markdown>{query.data}</Markdown>
    </div>
  );
}
