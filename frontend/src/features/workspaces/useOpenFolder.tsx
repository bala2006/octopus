import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { qk } from "@/hooks/queries";
import { DirectoryPicker } from "./DirectoryPicker";

/**
 * "Open project folder": shows the operating system's own folder dialog (where you can also create a new folder).
 * Octopus then creates `<folder>/.octopus` and manages it. Only when no desktop is available (Docker, SSH, a remote
 * browser) does it fall back to the in-app folder browser.
 */
export function useOpenFolder() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [fallback, setFallback] = React.useState<string | null>(null);
  const native = useQuery({ queryKey: ["native-dialog"], staleTime: Infinity, queryFn: () => unwrap(api.GET("/api/v1/fs/native")) });
  const pick = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/workspaces/native", { body: { default_permission: "ask" } })),
    onSuccess: (r) => {
      if (r.cancelled || !r.workspace) return;
      qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success(r.workspace.existing_project ? `Re-opened ${r.workspace.name}` : `Opened ${r.workspace.name}`,
        { description: r.workspace.existing_project ? "Found its .octopus folder: everything is restored." : `Octopus created ${r.workspace.path}/.octopus for this project.` });
      nav(`/w/${r.workspace.id}/canvas`);
    },
    onError: (e: Error) => { toast.error("Couldn't open the folder dialog", { description: e.message }); setFallback(e.message); },
  });
  const open = React.useCallback(() => {
    if (native.data?.available) pick.mutate();
    else setFallback(native.data?.reason || "The system folder dialog isn't available here.");
  }, [native.data, pick]);

  const element = (
    <>
      {pick.isPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm" role="status" aria-live="polite">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-border bg-card p-6 text-center shadow-lg">
            <FolderOpen className="h-7 w-7 text-primary" />
            <div className="text-sm font-semibold">Choose a folder in the window that just opened</div>
            <p className="text-xs text-muted-foreground">Pick an existing folder or create a new one there. Octopus keeps its data in a <code>.octopus</code> folder inside it.</p>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        </div>
      )}
      <DirectoryPicker open={fallback !== null} onOpenChange={(o) => !o && setFallback(null)} notice={fallback ?? undefined} />
    </>
  );
  return { open, busy: pick.isPending, nativeAvailable: !!native.data?.available, element };
}
