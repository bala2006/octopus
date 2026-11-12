import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useWorkbenchStore } from "@/features/editor/workbenchStore";
import { usePendingAttachments } from "@/features/chat/attachments";
import { api, unwrap } from "@/lib/api";
import { qk } from "@/hooks/queries";
import type { WorkspaceOut } from "@/types";
import { CreateProjectDialog, type ProjectFolder } from "./CreateProjectDialog";

export function useOpenFolder() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [choosingFolder, setChoosingFolder] = React.useState(false);
  const native = useQuery({
    queryKey: ["native-dialog"],
    staleTime: Infinity,
    queryFn: () => unwrap(api.GET("/api/v1/fs/native")),
  });

  const opened = (workspace: WorkspaceOut) => {
    if (location.pathname === "/") {
      useWorkbenchStore.getState().stageHomePrompt(workspace.id);
      usePendingAttachments.getState().stageHome(workspace.id);
    }
    void queryClient.invalidateQueries({ queryKey: qk.workspaces });
    toast.success(
      workspace.existing_project
        ? `Re-opened ${workspace.name}`
        : `Project ${workspace.name} is ready`,
      {
        description: workspace.existing_project
          ? "Found its .octopus folder: everything is restored."
          : `Octopus created ${workspace.path}/.octopus for this project.`,
      },
    );
    navigate(`/w/${workspace.id}/agent`);
  };

  const create = useMutation({
    mutationFn: ({ folder, name }: { folder: ProjectFolder; name: string }) =>
      unwrap(
        api.POST("/api/v1/workspaces", {
          body: {
            path: folder.path,
            name,
          },
        }),
      ),
    onSuccess: opened,
  });

  const chooseFolder = async (): Promise<ProjectFolder | null> => {
    setChoosingFolder(true);
    try {
      const availability = native.data ?? (await native.refetch()).data;
      if (availability?.available) {
        const picked = await unwrap(api.POST("/api/v1/fs/native/pick", {}));
        return picked.cancelled || !picked.path ? null : { path: picked.path };
      }

      throw new Error("The local folder picker is unavailable. You can paste a folder path instead.");
    } finally {
      setChoosingFolder(false);
    }
  };

  const openPicker = React.useCallback(() => setDialogOpen(true), []);
  const element = (
    <CreateProjectDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      onChooseFolder={chooseFolder}
      onCreateProject={(folder, name) => create.mutateAsync({ folder, name }).then(() => undefined)}
      choosingFolder={choosingFolder}
      creatingProject={create.isPending}
    />
  );

  return {
    // Legacy callers that need a project destination now use the same Create project flow.
    open: openPicker,
    openPicker,
    busy: choosingFolder || create.isPending,
    nativeAvailable: !!native.data?.available,
    element,
  };
}
