import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { File, Folder, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, unwrap } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function TrashPanel({
  workspace,
  onOpen,
  onRefresh,
}: {
  workspace: string;
  onOpen: (path: string) => void;
  onRefresh: () => void;
}) {
  const qc = useQueryClient();
  const params = { path: { workspace_id: workspace } };
  const items = useQuery({
    queryKey: ["editor-trash", workspace],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/w/{workspace_id}/editor/items/trash", { params }),
      ),
  });
  const restore = useMutation({
    mutationFn: (token: string) =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/editor/item/restore/{token}", {
          params: { path: { workspace_id: workspace, token } },
        }),
      ),
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: ["editor-trash", workspace] });
      onRefresh();
      if (item.kind === "file") onOpen(item.path);
      toast.success(`Restored ${item.path}`);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <div className="flex items-center gap-2 px-2 py-2 text-xs font-medium">
        <Trash2 className="h-3.5 w-3.5" />
        Project trash
      </div>
      <p className="px-2 pb-3 text-[11px] leading-relaxed text-muted-foreground">
        Restore deleted files and folders. The latest 100 items appear here.
        Restoring never overwrites another file.
      </p>
      {items.isPending && (
        <p role="status" className="p-2 text-xs text-muted-foreground">
          Loading trash…
        </p>
      )}
      {items.isError && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {items.error.message}
        </p>
      )}
      {items.data?.map((item) => (
        <div
          key={item.token}
          className="mb-2 rounded-lg border bg-background p-2 text-xs"
        >
          <div className="flex items-center gap-2">
            {item.kind === "folder" ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-steel" />
            ) : (
              <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span title={item.path} className="truncate font-medium">
              {item.path}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {new Date(item.deleted_at * 1000).toLocaleString()}
          </p>
          <Button
            className="mt-2 w-full"
            size="xs"
            variant="outline"
            aria-label={`Restore ${item.path}`}
            disabled={restore.isPending}
            loading={restore.isPending && restore.variables === item.token}
            onClick={() => restore.mutate(item.token)}
          >
            <RotateCcw />
            Restore
          </Button>
        </div>
      ))}
      {items.data?.length === 0 && (
        <p className="p-4 text-center text-xs text-muted-foreground">
          Trash is empty.
        </p>
      )}
    </div>
  );
}
