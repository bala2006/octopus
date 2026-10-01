import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { qk } from "@/hooks/queries";
import type { WorkspaceOut } from "@/types";
import { DirectoryPicker } from "./DirectoryPicker";
import { bridgeAvailable, bridgePick } from "./folderBridge";

/**
 * "Open project folder": shows the operating system's own folder dialog (where you can also create a new folder).
 * Octopus then creates `<folder>/.octopus` and manages it.
 *
 * 1. Octopus running natively on this machine: the backend shows the dialog.
 * 2. Octopus in Docker: the backend has no desktop, so the browser asks the laptop-side helper
 *    (scripts/folder_bridge.py, started by start.bat / start.sh) and the chosen laptop path is opened through the
 *    folder shared with the container.
 * 3. Neither available: the in-app folder browser (which in Docker browses the shared laptop folder).
 */
export function useOpenFolder() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [fallback, setFallback] = React.useState<string | null>(null);
  const native = useQuery({ queryKey: ["native-dialog"], staleTime: Infinity, queryFn: () => unwrap(api.GET("/api/v1/fs/native")) });
  const opened = (w: WorkspaceOut) => {
    qc.invalidateQueries({ queryKey: qk.workspaces });
    const where = w.display_path || w.path;
    toast.success(w.existing_project ? `Re-opened ${w.name}` : `Opened ${w.name}`,
      { description: w.existing_project ? "Found its .octopus folder: everything is restored." : `Octopus created ${where}/.octopus for this project.` });
    nav(`/w/${w.id}/canvas`);
  };
  const pick = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/workspaces/native", { body: { default_permission: "ask" } })),
    onSuccess: (r) => { if (!r.cancelled && r.workspace) opened(r.workspace); },
    onError: (e: Error) => { toast.error("Couldn't open the folder dialog", { description: e.message }); setFallback(e.message); },
  });
  const viaBridge = useMutation({
    mutationFn: async () => {
      const path = await bridgePick(native.data!.bridge_url!);
      if (!path) return null;
      return unwrap(api.POST("/api/v1/workspaces", { body: { path, default_permission: "ask" } }));
    },
    onSuccess: (w) => { if (w) opened(w); },
    onError: (e: Error) => { toast.error("Couldn't open that folder", { description: e.message }); setFallback(e.message); },
  });
  const open = React.useCallback(async () => {
    const d = native.data;
    if (d?.available) return pick.mutate();
    if (d?.bridge_url && await bridgeAvailable(d.bridge_url)) return viaBridge.mutate();
    const shared = d?.host_dir ? ` Browse the folders shared from your laptop (${d.host_dir}) below.` : "";
    setFallback(d?.bridge_url
      ? `Octopus runs in Docker, which can't open your laptop's folder dialog by itself. Start Octopus with start.bat / start.sh `
        + `(or run python scripts/folder_bridge.py on your laptop) to get the system dialog.${shared}`
      : (d?.reason || "The system folder dialog isn't available here.") + shared);
  }, [native.data, pick, viaBridge]);

  const busy = pick.isPending || viaBridge.isPending;
  const element = (
    <>
      {busy && (
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
  return { open: () => void open(), busy, nativeAvailable: !!native.data?.available, element };
}
