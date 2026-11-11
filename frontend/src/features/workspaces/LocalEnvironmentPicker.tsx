import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cpu, GitBranch, GitFork, LoaderCircle, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger, Select } from "@/components/ui/overlays";
import { fetchRaw } from "@/lib/api";

type LocalEnvironment = {
  repository: boolean;
  branch: string;
  branches: string[];
  dirty_count: number;
  worktrees: { path: string; branch: string }[];
  environments: { id: string; label: string; path: string }[];
  selected_environment: string | null;
};

type Selection = { newWorktree: boolean; branch: string };

type WorktreeResult = {
  workspace: { id: string; name: string };
  branch: string;
};

async function localRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchRaw(url, init);
  return response.json() as Promise<T>;
}

export function createLocalWorktree(workspaceId: string, baseBranch: string) {
  return localRequest<WorktreeResult>(`/api/v1/w/${encodeURIComponent(workspaceId)}/editor/git/worktree`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_branch: baseBranch }),
  });
}

export function LocalEnvironmentPicker({ workspaceId, value, onChange }: {
  workspaceId: string;
  value: Selection;
  onChange: (value: Selection) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const queryClient = useQueryClient();
  const queryKey = ["local-environment", workspaceId];
  const local = useQuery({
    queryKey,
    enabled: open && !!workspaceId,
    queryFn: () => localRequest<LocalEnvironment>(`/api/v1/w/${encodeURIComponent(workspaceId)}/editor/local-environment`),
  });
  const data = local.data;
  const currentBranch = data?.branch && data.branches.includes(data.branch) ? data.branch : data?.branches[0] ?? "";
  const branch = value.branch || currentBranch;

  React.useEffect(() => {
    if (currentBranch && !value.branch) onChange({ ...value, branch: currentBranch });
  }, [currentBranch, onChange, value]);

  const switchBranch = async (nextBranch: string) => {
    onChange({ ...value, branch: nextBranch });
    if (value.newWorktree || nextBranch === data?.branch) return;
    try {
      const updated = await localRequest<LocalEnvironment>(`/api/v1/w/${encodeURIComponent(workspaceId)}/editor/git/branch`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branch: nextBranch }),
      });
      queryClient.setQueryData(queryKey, updated);
      toast.success(`Switched to ${updated.branch}`);
    } catch (error) {
      onChange({ ...value, branch: data?.branch ?? "" });
      toast.error(error instanceof Error ? error.message : "Could not switch branches.");
    }
  };

  const setEnvironment = async (selected: string) => {
    try {
      const updated = await localRequest<LocalEnvironment>(`/api/v1/w/${encodeURIComponent(workspaceId)}/editor/local-environment`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: selected || null }),
      });
      queryClient.setQueryData(queryKey, updated);
      toast.success(selected ? "Local environment saved" : "Using the default environment");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the environment.");
    }
  };

  const setWorktree = (enabled: boolean) => {
    onChange({ newWorktree: enabled, branch: branch || "" });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" className="home-composer-settings" aria-label="Configure local environment" title="Configure local environment" disabled={!workspaceId}>
          <Settings2 />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[min(340px,calc(100vw-1rem))] rounded-2xl border bg-popover p-3 text-popover-foreground shadow-xl">
        <div className="mb-2 px-1 text-[12px] text-muted-foreground">Configure local environment</div>
        {local.isLoading ? (
          <div className="flex items-center gap-2 px-1 py-3 text-[13px] text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Reading local project settings…</div>
        ) : local.isError ? (
          <div className="px-1 py-2 text-[12px] text-destructive">Could not read this project’s local settings. <button className="underline" onClick={() => void local.refetch()}>Retry</button></div>
        ) : !data?.repository ? (
          <div className="px-1 py-2 text-[12px] leading-relaxed text-muted-foreground">This folder is not a Git repository. Local branch and worktree controls are unavailable.</div>
        ) : (
          <div className="space-y-1">
            <button type="button" role="switch" aria-checked={value.newWorktree} onClick={() => setWorktree(!value.newWorktree)} className="group flex min-h-9 w-full items-center justify-between rounded-lg px-1 text-left text-[13px] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
              <span className="flex items-center gap-2"><GitFork className="h-4 w-4 text-muted-foreground" />New worktree</span>
              <span className={`relative h-5 w-9 rounded-full transition-colors ${value.newWorktree ? "bg-primary" : "bg-muted-foreground/35"}`}>
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${value.newWorktree ? "translate-x-[18px]" : "translate-x-0.5"}`} />
              </span>
            </button>
            <div className="flex min-h-9 items-center gap-2 rounded-lg px-1">
              <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-[13px]">Branch</span>
              <div className="ml-auto w-[170px]">
                <Select
                  value={branch}
                  onValueChange={(next) => void switchBranch(next)}
                  disabled={local.isFetching || !data.branches.length || (!value.newWorktree && data.dirty_count > 0)}
                  ariaLabel="Local Git branch"
                  variant="ghost"
                  className="h-8"
                  options={data.branches.map((name) => ({ value: name, label: name, hint: value.newWorktree && name === data.branch ? "Starting point for an isolated Octopus branch" : undefined }))}
                />
              </div>
            </div>
            <div className="flex min-h-9 items-center gap-2 rounded-lg px-1">
              <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-[13px]">Environment</span>
              <div className="ml-auto w-[170px]">
                <Select
                  value={data.selected_environment ?? "none"}
                  onValueChange={(next) => void setEnvironment(next === "none" ? "" : next)}
                  ariaLabel="Local project environment"
                  variant="ghost"
                  className="h-8"
                  options={[{ value: "none", label: "No environment", hint: "Use Octopus’ default local runtime" }, ...data.environments.map((item) => ({ value: item.id, label: item.label, hint: item.path }))]}
                />
              </div>
            </div>
            {data.dirty_count > 0 && !value.newWorktree && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-muted-foreground">{data.dirty_count} local change{data.dirty_count === 1 ? "" : "s"}. Commit or stash before switching this folder’s branch. A new worktree keeps these files untouched.</p>
            )}
            {value.newWorktree && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-muted-foreground">On your next message, Octopus creates a sibling worktree and a new local branch from {branch || data.branch}. Uncommitted files stay in this folder.</p>
            )}
            <div className="mt-2 border-t border-border px-1 pt-2 text-[10px] text-muted-foreground">
              {data.worktrees.length} local worktree{data.worktrees.length === 1 ? "" : "s"}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
