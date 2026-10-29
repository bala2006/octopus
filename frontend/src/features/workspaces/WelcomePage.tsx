import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Code2,
  Compass,
  FolderOpen,
  Plus,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { useWorkspaces, qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import type { WorkspaceOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Select } from "@/components/ui/overlays";
import { PromptComposer } from "@/components/ui/surfaces";
import { DesktopLayout } from "@/components/layout/DesktopLayout";
import {
  defaultComposerSettings,
  useWorkbenchStore,
} from "@/features/editor/workbenchStore";
import { ModelPicker } from "@/features/editor/ModelPicker";
import { useOpenFolder } from "./useOpenFolder";

const IDEAS = [
  {
    icon: Code2,
    label: "Build something",
    prompt: "Help me build a new feature in this project. ",
  },
  {
    icon: Wrench,
    label: "Fix a problem",
    prompt: "Help me find and fix a problem in this project. ",
  },
  {
    icon: Compass,
    label: "Explore my code",
    prompt: "Explain how this project is organized and where I should start.",
  },
];

export function WelcomePage() {
  const projects = useWorkspaces();
  const folder = useOpenFolder();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [selected, setSelected] = React.useState("");
  const [forget, setForget] = React.useState<WorkspaceOut | null>(null);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const store = useWorkbenchStore();
  const available = [...(projects.data ?? [])]
    .filter((p) => p.exists)
    .sort((a, b) =>
      String(b.last_opened_at ?? "").localeCompare(
        String(a.last_opened_at ?? ""),
      ),
    );
  const project = available.find((p) => p.id === selected) ?? available[0];
  const preferenceKey = project?.id ?? "home";
  const preferences =
    store.preferences[preferenceKey] ??
    store.preferences.home ??
    defaultComposerSettings;
  const permissionCaption =
    project?.default_permission === "danger"
      ? "Full access. Edits run without approval."
      : project?.default_permission === "read_only"
        ? "Read only. No edits or commands."
        : project?.default_permission === "plan"
          ? "Your team proposes changes before writing files."
          : "Edits and commands need your approval.";
  const remove = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.DELETE("/api/v1/workspaces/{workspace_id}", {
          params: { path: { workspace_id: id } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success("Removed from the list. Your files are still on disk.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const continuePrompt = () => {
    if (!project || !store.homeDraft.trim()) return;
    store.stagePrompt(project.id, store.homeDraft);
    store.setHomeDraft("");
    navigate(`/w/${project.id}/agent`);
  };
  return (
    <DesktopLayout
      header={
        <>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            New conversation
          </span>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/guide">
              <BookOpen />
              Guide
            </Link>
          </Button>
        </>
      }
    >
      <div className="welcome-page">
        <div className="welcome-topline">
          <span>
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            Your local workspace
          </span>
          <Link to="/guide">
            How Octopus works
            <ArrowUpRight />
          </Link>
        </div>
        <div className="welcome-stage">
          <div className="welcome-intro">
            <img src="/octopus.svg" alt="" className="welcome-logo" />
            <h1>What do you want to build?</h1>
            <p>
              Bring an idea, a question, or a work in progress.
              <br className="hidden sm:block" /> Your team is ready to get into
              it.
            </p>
            <div className="welcome-ideas">
              {IDEAS.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  onClick={() => {
                    store.setHomeDraft(prompt);
                    input.current?.focus();
                  }}
                >
                  <Icon />
                  <span>{label}</span>
                  <ArrowUpRight className="idea-arrow" />
                </button>
              ))}
            </div>
          </div>
          <div className="welcome-projects" aria-label="Recent projects">
            <div className="flex items-center justify-between px-1">
              <h2>Pick up where you left off</h2>
              <button onClick={folder.open}>
                Open folder
                <Plus className="h-3 w-3" />
              </button>
            </div>
            {projects.isLoading ? (
              <div className="skeleton h-14" />
            ) : projects.isError ? (
              <div role="alert" className="p-3 text-sm text-muted-foreground">
                Projects could not be loaded.{" "}
                <button
                  className="underline"
                  onClick={() => void projects.refetch()}
                >
                  Try again
                </button>
              </div>
            ) : available.length ? (
              available.slice(0, 3).map((p) => (
                <div key={p.id} className="welcome-project-row">
                  <Link
                    to={`/w/${p.id}/agent`}
                    onClick={() => store.stageHomePrompt(p.id)}
                  >
                    <FolderOpen />
                    <span>
                      <strong>{p.name}</strong>
                      <small>{p.display_path || p.path}</small>
                    </span>
                    <ArrowUpRight className="project-row-arrow" />
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Forget ${p.name}`}
                    onClick={() => setForget(p)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))
            ) : (
              <button className="welcome-first-project" onClick={folder.open}>
                <FolderOpen />
                <span>Open your first project folder</span>
                <Plus />
              </button>
            )}
          </div>
        </div>
        <form
          className="home-prompt-form shrink-0"
          onSubmit={(event) => {
            event.preventDefault();
            continuePrompt();
          }}
        >
          <PromptComposer
            caption={
              <>
                <ShieldCheck className="h-3 w-3 shrink-0" />
                <span>
                  {project
                    ? permissionCaption
                    : "Choose a project folder to continue. Your draft is saved."}
                </span>
                <span className="ml-auto hidden shrink-0 sm:inline">
                  Enter to continue
                </span>
              </>
            }
            controls={
              <>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Open project folder"
                  onClick={folder.open}
                  loading={folder.busy}
                >
                  <Plus />
                </Button>
                {project ? (
                  <Select
                    ariaLabel="Project for new conversation"
                    variant="ghost"
                    value={project.id}
                    onValueChange={setSelected}
                    className="w-auto max-w-48"
                    options={available.map((item) => ({
                      value: item.id,
                      label: item.name,
                    }))}
                  />
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={folder.open}
                  >
                    Choose a project
                  </Button>
                )}
                <span className="flex-1" />
                <ModelPicker
                  value={preferences}
                  onChange={(value) => store.configure(preferenceKey, value)}
                />
                <Button
                  type="submit"
                  size="icon"
                  className="composer-send ml-auto sm:ml-0"
                  aria-label="Continue in selected project"
                  title="Continue in selected project"
                  disabled={!project || !store.homeDraft.trim()}
                >
                  <ArrowUp />
                </Button>
              </>
            }
          >
            <Textarea
              ref={input}
              aria-label="Describe what you want to build"
              placeholder="Ask Octopus to build, fix, or explore…"
              rows={2}
              maxLength={8000}
              value={store.homeDraft}
              onChange={(event) => store.setHomeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  continuePrompt();
                }
              }}
            />
          </PromptComposer>
        </form>
      </div>
      {folder.element}
      <ConfirmDialog
        open={!!forget}
        onOpenChange={(open) => {
          if (!open) setForget(null);
        }}
        title={`Remove "${forget?.name}" from Octopus?`}
        description="Your folder and its history stay on disk. Open the folder again to bring it back."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (forget) remove.mutate(forget.id);
        }}
      />
    </DesktopLayout>
  );
}
