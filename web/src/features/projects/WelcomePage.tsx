import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Folder,
  FolderOpen,
  Laptop,
  Plus,
  Paperclip,
  Search,
  ShieldCheck,
} from "lucide-react";
import { qk, useSettings, useWorkspaces } from "@/hooks/queries";
import { APPROVAL_MODES, approvalModeOf } from "@/lib/meta";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/primitives";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/overlays";
import { PromptComposer } from "@/components/ui/surfaces";
import { AttachmentChips, useAttachments, usePendingAttachments } from "@/features/chat/attachments";
import { DesktopLayout } from "@/components/layout/DesktopLayout";
import {
  defaultComposerSettings,
  useWorkbenchStore,
} from "@/features/conversation/workbenchStore";
import { ModelPicker } from "@/features/conversation/ModelPicker";
import { ApprovalModePicker } from "@/features/conversation/ApprovalModePicker";
import { useOpenFolder } from "./useOpenFolder";
import { createLocalWorktree, LocalEnvironmentPicker } from "./LocalEnvironmentPicker";

export function WelcomePage() {
  const projects = useWorkspaces();
  const folder = useOpenFolder();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selected, setSelected] = React.useState("");
  const [projectSearch, setProjectSearch] = React.useState("");
  const [projectPickerOpen, setProjectPickerOpen] = React.useState(false);
  const input = React.useRef<HTMLTextAreaElement>(null);
  const store = useWorkbenchStore();
  const attachments = useAttachments({ images: true, initial: usePendingAttachments.getState().home });
  React.useEffect(() => { usePendingAttachments.getState().setHome(attachments.files); }, [attachments.files]);
  const [adding, setAdding] = React.useState(false);
  const [gitSelection, setGitSelection] = React.useState({ newWorktree: false, branch: "" });
  const [creatingWorktree, setCreatingWorktree] = React.useState(false);
  const available = [...(projects.data ?? [])]
    .filter((p) => p.exists)
    .sort((a, b) =>
      String(b.last_opened_at ?? "").localeCompare(
        String(a.last_opened_at ?? ""),
      ),
    );
  const project = available.find((p) => p.id === selected) ?? available[0];
  React.useEffect(() => setGitSelection({ newWorktree: false, branch: "" }), [project?.id]);
  const filteredProjects = available.filter((item) => item.name.toLowerCase().includes(projectSearch.trim().toLowerCase()));
  const preferenceKey = project?.id ?? "home";
  const preferences =
    store.preferences[preferenceKey] ??
    store.preferences.home ??
    defaultComposerSettings;
  const settings = useSettings();
  const caption = APPROVAL_MODES[approvalModeOf(settings.data?.approval_mode)].caption;
  const continuePrompt = async () => {
    if (!store.homeDraft.trim() || attachments.uploading || creatingWorktree) return;
    // No project yet: choose a folder; the draft and attachments move into the new project when it opens.
    if (!project) { folder.openPicker(); return; }
    let targetWorkspaceId = project.id;
    if (gitSelection.newWorktree) {
      if (!gitSelection.branch) {
        toast.error("Choose a local branch to start the worktree from.");
        return;
      }
      setCreatingWorktree(true);
      try {
        const created = await createLocalWorktree(project.id, gitSelection.branch);
        targetWorkspaceId = created.workspace.id;
        await queryClient.invalidateQueries({ queryKey: qk.workspaces });
        toast.success(`Created local worktree on ${created.branch}`);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not create a local worktree.");
        setCreatingWorktree(false);
        return;
      }
      setCreatingWorktree(false);
    }
    usePendingAttachments.getState().stageHome(targetWorkspaceId);
    store.stagePrompt(targetWorkspaceId, store.homeDraft);
    store.setHomeDraft("");
    navigate(`/w/${targetWorkspaceId}/agent`);
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
        <div className="welcome-stage">
          <div className="welcome-intro">
            <img className="welcome-logo" src="/octopus.svg" alt="" />
            <h1>What should we build in Octopus?</h1>
          </div>
        <form
          className="home-prompt-form shrink-0"
          onSubmit={(event) => {
            event.preventDefault();
            continuePrompt();
          }}
        >
          <div className="home-composer-context">
            <Popover open={projectPickerOpen} onOpenChange={(open) => { setProjectPickerOpen(open); if (!open) setProjectSearch(""); }}>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="home-project-trigger" aria-label="Choose project">
                  <Folder />
                  <span>{project?.name ?? "Choose a project"}</span>
                  <ChevronDown />
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" align="start" className="home-project-menu">
                <label className="home-project-search">
                  <Search />
                  <Input autoFocus value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" />
                </label>
                <div className="home-project-options" role="listbox" aria-label="Projects">
                  {filteredProjects.map((item) => (
                    <button key={item.id} type="button" role="option" aria-selected={item.id === project?.id} className="home-project-option" onClick={() => { setSelected(item.id); setProjectPickerOpen(false); }}>
                      <Folder />
                      <span>{item.name}</span>
                      {item.id === project?.id && <Check />}
                    </button>
                  ))}
                  {!filteredProjects.length && <p className="home-project-empty">No projects match that search.</p>}
                </div>
                <div className="home-project-menu-footer">
                  <button type="button" onClick={() => { setProjectPickerOpen(false); folder.openPicker(); }}><Plus />New project</button>
                </div>
              </PopoverContent>
            </Popover>
            <span className="home-computer-context" title="Agents work in the folder on this computer"><Laptop />Runs on this computer</span>
            {project && <LocalEnvironmentPicker key={project.id} workspaceId={project.id} value={gitSelection} onChange={setGitSelection} />}
          </div>
          <PromptComposer
            caption={
              <>
                <ShieldCheck className="h-3 w-3 shrink-0" />
                <span>
                  {project
                  ? caption
                    : "Octopus works inside a project folder. Send to choose one; your message goes with it."}
                </span>
                <span className="ml-auto hidden shrink-0 sm:inline">
                  Enter to continue
                </span>
              </>
            }
            controls={
              <>
                <Popover open={adding} onOpenChange={setAdding}>
                  <PopoverTrigger asChild>
                    <Button type="button" size="icon" variant="ghost" aria-label="Add files or project" disabled={attachments.uploading}><Plus /></Button>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="composer-add-menu">
                    <button type="button" className="composer-add-item" onClick={() => { attachments.pick(); setAdding(false); }}><Paperclip /><span>Add photos &amp; files</span><small>Upload from computer</small></button>
                    <button type="button" className="composer-add-item" onClick={() => { setAdding(false); folder.openPicker(); }}><FolderOpen /><span>New project</span><small>Choose a local folder and name your project</small></button>
                  </PopoverContent>
                </Popover>
                <ApprovalModePicker />
                <span className="home-project-current"><Folder />{project?.name ?? "No project"}</span>
                <span className="flex-1" />
                <ModelPicker
                  value={preferences}
                  onChange={(value) => store.configure(preferenceKey, { ...preferences, ...value })}
                />
                <Button
                  type="submit"
                  size="icon"
                  className="composer-send ml-auto sm:ml-0"
                  aria-label={project ? "Continue in selected project" : "Choose a project folder and continue"}
                  title={project ? "Continue in selected project" : "Choose a project folder and continue"}
                  disabled={!store.homeDraft.trim() || attachments.uploading || creatingWorktree}
                  loading={creatingWorktree}
                >
                  <ArrowUp />
                </Button>
              </>
            }
          >
            {attachments.input}
            <AttachmentChips files={attachments.files} onRemove={attachments.remove} />
            <Textarea
              ref={input}
              aria-label="Describe what you want to build"
              placeholder="Ask Octopus to build, fix, or explore…"
              rows={2}
              maxLength={8000}
              value={store.homeDraft}
              onChange={(event) => store.setHomeDraft(event.target.value)}
              onPaste={attachments.onPaste}
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

      </div>
      {folder.element}
    </DesktopLayout>
  );
}
