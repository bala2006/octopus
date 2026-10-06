import * as React from "react";
import { toast } from "sonner";
import { api, fetchRaw, unwrap } from "@/lib/api";
import type { components } from "@/types/api.gen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/overlays";
import { useEditorStore } from "./editorStore";

type Item = components["schemas"]["FileItem"];
type Action =
  | { kind: "move"; item: Item }
  | { kind: "trash"; item: Item }
  | { kind: "upload"; file: File };

export function useFileActions(
  workspace: string,
  onOpen: (path: string) => void,
  onRefresh: () => void,
) {
  const [action, setAction] = React.useState<Action | null>(null);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const params = React.useMemo(
    () => ({ path: { workspace_id: workspace } }),
    [workspace],
  );

  const start = React.useCallback(
    async (kind: "move" | "trash", path: string) => {
      const drafts = useEditorStore.getState().projects[workspace]?.tabs ?? [];
      if (
        drafts.some(
          (tab) =>
            (tab.path === path || tab.path.startsWith(`${path}/`)) &&
            tab.draft !== tab.content,
        )
      ) {
        toast.error(
          "Save the unsaved files in this folder before moving or deleting it.",
        );
        return;
      }
      try {
        const item = await unwrap(
          api.GET("/api/v1/w/{workspace_id}/editor/item", {
            params: { ...params, query: { path } },
          }),
        );
        setName(path);
        setError("");
        setAction({ kind, item });
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Could not read file details",
        );
      }
    },
    [workspace, params],
  );
  const upload = (file: File) => {
    if (file.size > 20_000_000) {
      toast.error("Upload is limited to 20 MB per file.");
      return;
    }
    setName(file.name);
    setError("");
    setAction({ kind: "upload", file });
  };
  const submit = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "upload") {
        const form = new FormData();
        form.append("file", action.file);
        const item = await unwrap(
          api.POST("/api/v1/w/{workspace_id}/editor/asset", {
            params: { ...params, query: { path: name.trim() } },
            body: { file: "" },
            bodySerializer: () => form,
          }),
        );
        onOpen(item.path);
        toast.success(`Uploaded ${item.path}`);
      } else if (action.kind === "move") {
        const item = await unwrap(
          api.POST("/api/v1/w/{workspace_id}/editor/item/move", {
            params,
            body: {
              path: action.item.path,
              revision: action.item.revision,
              destination: name.trim(),
            },
          }),
        );
        useEditorStore.getState().move(workspace, action.item.path, item.path);
        const active = useEditorStore.getState().projects[workspace]?.active;
        if (active) onOpen(active);
        toast.success(`Moved to ${item.path}`);
      } else {
        const { token } = await unwrap(
          api.POST("/api/v1/w/{workspace_id}/editor/item/trash", {
            params,
            body: { path: action.item.path, revision: action.item.revision },
          }),
        );
        useEditorStore.getState().remove(workspace, action.item.path);
        toast.success(`Deleted ${action.item.path}`, {
          duration: 15000,
          action: {
            label: "Undo",
            onClick: () => {
              void unwrap(
                api.POST(
                  "/api/v1/w/{workspace_id}/editor/item/restore/{token}",
                  { params: { path: { workspace_id: workspace, token } } },
                ),
              )
                .then((item) => {
                  onRefresh();
                  if (item.kind === "file") onOpen(item.path);
                })
                .catch((e: Error) => toast.error(e.message));
            },
          },
        });
      }
      onRefresh();
      setAction(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "File operation failed");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (!busy) setAction(null);
  };
  const download = React.useCallback(
    async (path: string) => {
      try {
        const response = await fetchRaw(
          `/api/v1/w/${workspace}/editor/download?${new URLSearchParams({ path })}`,
        );
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = path.split("/").pop() ?? "file";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Download failed");
      }
    },
    [workspace],
  );
  return {
    action,
    name,
    setName,
    error,
    busy,
    start,
    upload,
    download,
    submit,
    close,
  };
}

export function FileActionDialogs({
  actions,
}: {
  actions: ReturnType<typeof useFileActions>;
}) {
  const { action, name, setName, error, busy, close, submit } = actions;
  const folder = action?.kind !== "upload" && action?.item.kind === "folder";
  return (
    <>
      <Dialog
        open={!!action && action.kind !== "trash"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>
            {action?.kind === "upload"
              ? "Upload a file"
              : `Rename or move ${folder ? "folder" : "file"}`}
          </DialogTitle>
          <DialogDescription>
            {action?.kind === "upload"
              ? "Choose where to save this file. Existing files are never overwritten. Maximum 20 MB."
              : "Enter the destination relative to your project. Parent folders are created automatically."}
          </DialogDescription>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              autoFocus
              aria-label="File or folder path"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={400}
              disabled={busy}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={close}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                loading={busy}
                disabled={busy || !name.trim()}
              >
                {action?.kind === "upload"
                  ? "Upload"
                  : `Move ${folder ? "folder" : "file"}`}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={action?.kind === "trash"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent role="alertdialog" className="max-w-md">
          <DialogTitle>Delete this {folder ? "folder" : "file"}?</DialogTitle>
          <DialogDescription>
            {action?.kind === "trash" && action.item.path}{" "}
            {folder ? "and all its contents" : ""} will move to the project’s
            trash. You can undo from the notification.
          </DialogDescription>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              disabled={busy}
              onClick={() => void submit()}
            >
              Delete {folder ? "folder" : "file"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
