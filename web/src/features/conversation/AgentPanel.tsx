import * as React from "react";
import { useLiveRun } from "@/features/runs/liveRun";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  FileCode2,
  Folder,
  History,
  Laptop,
  Network,
  Pause,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Check,
  Paperclip,
  MessageSquare,
  Globe,
  ListTodo,
  Wrench,
  FileText,
  Minus,
  Square,
  Loader2,
  CircleAlert,
} from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn, parseUtc } from "@/lib/utils";
import {
  useCanvas,
  useCompanies,
  useCompanyId,
  useRun,
  useRuns,
  useSettings,
  useWorkspace,
  qk,
} from "@/hooks/queries";
import type {
  AgentOut,
  CompanyOut,
  CanvasOut,
  ParsedFileOut,
} from "@/types";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import {
  ConfirmDialog,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/overlays";
import { PromptComposer } from "@/components/ui/surfaces";
import { ConnectionDot } from "@/components/common";
import { NewCompanyDialog } from "@/features/projects/NewCompanyDialog";
import {
  useAttachments,
  AttachmentChips,
  attachmentPayload,
  usePendingAttachments,
} from "@/features/chat/attachments";
import { RunDialog } from "@/features/runs/RunDialog";
import { defaultRunBudget } from "@/features/runs/runDefaults";
import { RunFeed, ToolLog } from "@/features/runs/RunFeed";
import { BrowserView } from "@/features/runs/BrowserView";
import { isBrowsing } from "@/features/runs/browserSteps";
import { RunStrip, conversationStatus } from "./RunStrip";
import { TaskBoard } from "@/features/runs/RunWidgets";
import { ReportView } from "@/features/runs/RunReport";
import { ApprovalCard } from "@/features/runs/ApprovalCard";
import { QuestionCard } from "@/features/runs/QuestionCard";
import { useRunStream } from "@/features/runs/useRunStream";
import { liveOverlay, TERMINAL } from "@/features/runs/runState";
import { useEditorStore } from "@/features/code/editorStore";
import { contextGoal, type CodeContext } from "./agentContext";
import { APPROVAL_MODES, approvalModeOf } from "@/lib/meta";
import {
  defaultComposerSettings,
  recordedComposerSettings,
  threadKey,
  useWorkbenchStore,
} from "./workbenchStore";
import { ModelPicker } from "./ModelPicker";
import { ApprovalModePicker } from "./ApprovalModePicker";

type PromptSubmission = {
  content: string;
  contexts: CodeContext[];
  files: ParsedFileOut[];
  clientId: string;
};

export type FloatingChatState =
  "full" | "expanded" | "compose" | "minimized" | "collapsed";
type FloatingWindow = {
  state: FloatingChatState;
  onStateChange: (state: FloatingChatState) => void;
  menu: React.ReactNode;
};

export function AgentPanel({
  workspace,
  current,
  selection,
  selectionToken = 0,
  onSelectionConsumed,
  files,
  onOpen,
  onClose,
  focusToken = 0,
  presentation = "panel",
  floatingWindow,
}: {
  workspace: string;
  current?: CodeContext;
  selection?: CodeContext;
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
  focusToken?: number;
  selectionToken?: number;
  onSelectionConsumed?: () => void;
  presentation?: "panel" | "conversation";
  floatingWindow?: FloatingWindow;
}) {
  const { companyId } = useCompanyId();
  const attachments = useAttachments({ images: true });
  React.useEffect(() => {
    const files = usePendingAttachments.getState().take(workspace);
    if (files.length) attachments.setFiles((current) => [...current, ...files]);
  }, [workspace, attachments.setFiles]);
  return (
    <CompanyAgentPanel
      key={`${workspace}/${companyId}`}
      workspace={workspace}
      companyId={companyId}
      attachments={attachments}
      current={current}
      selection={selection}
      selectionToken={selectionToken}
      onSelectionConsumed={onSelectionConsumed}
      files={files}
      onOpen={onOpen}
      onClose={onClose}
      focusToken={focusToken}
      presentation={presentation}
      floatingWindow={floatingWindow}
    />
  );
}

function CompanyAgentPanel({
  workspace: w,
  companyId,
  attachments,
  current,
  selection,
  selectionToken,
  onSelectionConsumed,
  files,
  onOpen,
  onClose,
  focusToken,
  presentation,
  floatingWindow,
}: {
  workspace: string;
  companyId: string;
  attachments: ReturnType<typeof useAttachments>;
  current?: CodeContext;
  selection?: CodeContext;
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
  focusToken: number;
  selectionToken: number;
  onSelectionConsumed?: () => void;
  presentation: "panel" | "conversation";
  floatingWindow?: FloatingWindow;
}) {
  const qc = useQueryClient();
  const companiesQuery = useCompanies(w);
  const canvas = useCanvas(w, companyId);
  const ws = useWorkspace(w);
  const settings = useSettings();
  const runs = useRuns(w, companyId, true);
  const key = threadKey(w, companyId);
  const store = useWorkbenchStore();
  const preferences =
    store.preferences[w] ?? store.preferences.home ?? defaultComposerSettings;
  const selected = store.threads[key];
  const runId = companyId
    ? selected === undefined
      ? runs.data?.[0]?.id
      : (selected ?? undefined)
    : undefined;
  const run = useRun(w, runId ?? "");
  const retryIdentity = React.useRef<{ fingerprint: string; id: string } | null>(null);
  const base =
    (run.data?.snapshot?.agents as AgentOut[] | undefined) ??
    canvas.data?.agents ??
    [];
  const names = React.useMemo(
    () => Object.fromEntries(base.map((a) => [a.id, a.name])),
    [base],
  );
  const { state, conn } = useRunStream(w, run.data ? runId : undefined, names);
  const publishLive = useLiveRun((l) => l.publish);
  React.useEffect(() => {
    const team = [...base, ...state.extraAgents];
    publishLive(runId ?? null, state.extraAgents, runId ? liveOverlay(state, team, { ...canvas.data?.departments, ...state.departments }) : null);
  }, [runId, state, base, canvas.data?.departments, publishLive]);
  React.useEffect(() => () => publishLive(null, [], null), [publishLive]);
  const agents = Object.fromEntries(
    [...base, ...state.extraAgents].map((a) => [
      a.id,
      { ...a, ...state.agentPatches[a.id] },
    ]),
  );
  const status =
    state.replayDone || state.live ? state.status : run.data?.status;
  const active = !!runId && !!status && !TERMINAL.has(status);
  const browsing = Object.values(state.activity).some(isBrowsing);
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (!active || !floatingWindow) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, !!floatingWindow]);
  const elapsed = Math.max(
    0,
    Math.floor(
      (now - parseUtc(run.data?.started_at ?? run.data?.created_at ?? "")) /
        1000,
    ),
  );
  const workingLabel =
    status === "paused"
      ? "Work paused"
      : status === "awaiting_user"
        ? "Waiting on you"
        : active
          ? Number.isFinite(elapsed)
            ? `Working for ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
            : "Working…"
          : "Message Octopus…";
  const text = store.drafts[key] ?? "";
  const pendingPrompt = store.pendingPrompts[w];
  const conversation = presentation === "conversation";
  const [contexts, setContexts] = React.useState<CodeContext[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [browsingFiles, setBrowsingFiles] = React.useState(false);
  const [fileSearch, setFileSearch] = React.useState("");
  const [conversationTab, setConversationTab] = React.useState<
    "chat" | "tasks" | "browser" | "tools" | "report"
  >("chat");
  React.useEffect(() => setConversationTab("chat"), [runId]);
  const [advanced, setAdvanced] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [internal, setInternal] = React.useState(false);
  const [error, setError] = React.useState("");
  const input = React.useRef<HTMLTextAreaElement>(null);
  const floatingState = floatingWindow?.state;
  const changeFloatingState = floatingWindow?.onStateChange;
  React.useLayoutEffect(() => {
    if (!floatingWindow || !input.current) return;
    input.current.style.height = "0px";
    input.current.style.height = `${floatingState === "minimized" ? 24 : Math.min(160, Math.max(24, input.current.scrollHeight))}px`;
  }, [text, pendingPrompt, floatingState, !!floatingWindow]);
  React.useEffect(() => {
    if (state.pendingApproval || state.awaiting || error)
      changeFloatingState?.("expanded");
  }, [state.pendingApproval, state.awaiting, error, changeFloatingState]);
  React.useEffect(() => {
    if (attachments.files.length && floatingState === "minimized")
      changeFloatingState?.("compose");
  }, [attachments.files.length, floatingState, changeFloatingState]);
  const submitLock = React.useRef(false);
  const preparedCompany = React.useRef<CanvasOut | null>(null);
  const recordedBudget = recordedComposerSettings(run.data?.budget);
  const approvalMode = approvalModeOf(settings.data?.approval_mode);
  React.useEffect(() => {
    if (focusToken) input.current?.focus();
  }, [focusToken]);
  React.useEffect(() => {
    if (companyId && pendingPrompt && !text.trim())
      store.importPrompt(w, companyId);
  }, [companyId, pendingPrompt, text, w, store.importPrompt]);
  React.useEffect(() => {
    if (!conversation) return;
    const focus = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", focus);
    return () => window.removeEventListener("keydown", focus);
  }, [conversation]);
  const add = (item: CodeContext) => {
    setContexts((items) =>
      [
        ...items.filter(
          (c) => c.path !== item.path || c.startLine !== item.startLine,
        ),
        item,
      ].slice(-8),
    );
    setAdding(false);
    input.current?.focus();
  };
  const lastSelectionRequest = React.useRef(0);
  React.useEffect(() => {
    if (selectionToken > lastSelectionRequest.current && selection?.content)
      add(selection);
    lastSelectionRequest.current = selectionToken;
    if (selectionToken) onSelectionConsumed?.();
  }, [selectionToken]); // selection changes alone never attach code
  const submit = useMutation({
    mutationFn: async (prompt: PromptSubmission) => {
      const context = await Promise.all(
        prompt.contexts.map(async (c) => {
          if (c.startLine) return c;
          const tab = useEditorStore
            .getState()
            .projects[w]?.tabs.find((t) => t.path === c.path);
          if (tab)
            return {
              ...c,
              content: tab.draft,
              dirty: tab.draft !== tab.content,
            };
          const doc = await unwrap(
            api.GET("/api/v1/w/{workspace_id}/editor/document", {
              params: { path: { workspace_id: w }, query: { path: c.path } },
            }),
          );
          return { ...c, content: doc.content, dirty: false };
        }),
      );
      const goal = contextGoal(prompt.content, context);
      if (runId) {
        await unwrap(api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/continue", {
          params: { path: { workspace_id: w, run_id: runId } },
          body: { content: goal, attachments: attachmentPayload(prompt.files), client_request_id: prompt.clientId },
        }));
        return { id: runId, company: undefined, queued: false };
      }
      const company = companyId
        ? undefined
        : (preparedCompany.current ??
          (await unwrap(
            api.POST("/api/v1/w/{workspace_id}/companies/from-template", {
              params: { path: { workspace_id: w } },
              body: {
                template_key: "adaptive",
                name: "Octopus",
                goal,
              },
            }),
          )));
      if (company) preparedCompany.current = company;
      const targetCompany = companyId || company?.company.id || "";
      const result = await unwrap(
        api.POST("/api/v1/w/{workspace_id}/runs", {
          params: { path: { workspace_id: w } },
          body: {
            company_id: targetCompany,
            goal,
            mode: "autonomous",
            attachments: attachmentPayload(prompt.files),
            ...{ client_request_id: prompt.clientId },
            budget: { ...defaultRunBudget(), model: preferences.model, reasoning_effort: preferences.reasoning_effort },
          },
        }),
      );
      return { id: result.id, company, queued: false };
    },
    onMutate: () => setError(""),
    onSuccess: ({ id, company, queued }, submitted) => {
      changeFloatingState?.(queued ? "compose" : "expanded");
      retryIdentity.current = null;
      const targetKey = company ? threadKey(w, company.company.id) : key;
      store.selectThread(targetKey, id);
      if (company) {
        if (
          useWorkbenchStore.getState().pendingPrompts[w] === submitted.content
        )
          store.discardPrompt(w);
        qc.setQueryData(qk.canvas(w, company.company.id), company);
        qc.setQueryData<CompanyOut[]>(qk.companies(w), (old) => [
          company.company,
          ...(old ?? []).filter((item) => item.id !== company.company.id),
        ]);
        useApp.getState().setCompany(w, company.company.id);
      }
      if (useWorkbenchStore.getState().drafts[key] === submitted.content)
        store.draft(key, "");
      setContexts([]);
      attachments.clear();
      void qc.invalidateQueries({ queryKey: qk.runs(w) });
      void qc.invalidateQueries({ queryKey: qk.run(w, id) });
    },
    onError: (e: Error) => setError(e.message),
    onSettled: () => {
      submitLock.current = false;
    },
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "step" | "stop") =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/control/{action}", {
          params: { path: { workspace_id: w, run_id: runId!, action } },
        }),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.run(w, runId!) });
    },
    onError: (e: Error) => setError(e.message),
  });
  const approval = useMutation({
    mutationFn: (decision: {
      approved: boolean;
      scope: "once" | "always";
      reason?: string;
    }) =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/approve", {
          params: { path: { workspace_id: w, run_id: runId! } },
          body: {
            approval_id: state.pendingApproval!.id,
            approved: decision.approved,
            scope: decision.scope,
            reason: decision.reason ?? "",
          },
        }),
      ),
    onError: (e: Error) => setError(e.message),
  });
  const canSubmit =
    !!(companyId ? text : (pendingPrompt ?? text)).trim() &&
    !submit.isPending &&
    !attachments.uploading &&
    !settings.isPending &&
    !settings.isError &&
    !companiesQuery.isPending &&
    !companiesQuery.isError &&
    !(companyId && canvas.data?.agents.length === 0) &&
    !run.isLoading &&
    (!runId || !!run.data);
  const send = () => {
    if (!canSubmit || submitLock.current) return;
    const prompt = {
      content: companyId ? text : (pendingPrompt ?? text),
      contexts,
      files: attachments.files,
    };
    const fingerprint = JSON.stringify({ runId, key, ...prompt });
    if (retryIdentity.current?.fingerprint !== fingerprint)
      retryIdentity.current = { fingerprint, id: crypto.randomUUID() };
    submitLock.current = true;
    submit.mutate({ ...prompt, clientId: retryIdentity.current.id });
  };
  const newThread = () => {
    store.selectThread(key, null);
    setContexts([]);
    attachments.clear();
    setError("");
    input.current?.focus();
  };
  const conversationOptions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="home-composer-settings"
          aria-label="Conversation options"
        >
          <SlidersHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-64">
        <DropdownMenuLabel>Conversation options</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!companyId}
          onSelect={() => setAdvanced(true)}
        >
          <Settings2 />
          New conversation with limits…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setInternal(!internal)}>
          <History />
          {internal ? "Show replies only" : "Show the team\u2019s internal messages"}
          {internal && <Check className="ml-auto" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <section
      className={cn(
        "agent-workbench flex h-full min-h-0 flex-col",
        conversation ? "conversation-workbench" : "bg-surface/30",
      )}
      aria-label="Agent workbench"
      data-testid="agent-workbench"
    >
      {floatingWindow?.state === "collapsed" && (
        <button
          type="button"
          className="floating-chat-orb"
          aria-label={`Restore chat: ${active ? workingLabel : conversationStatus(status) || "Ready"}`}
          title={active ? workingLabel : "Open chat"}
          onClick={() => floatingWindow.onStateChange("minimized")}
        >
          {state.pendingApproval || state.awaiting ? (
            <CircleAlert />
          ) : status === "paused" ? (
            <Pause />
          ) : active ? (
            <Loader2 className="animate-spin" />
          ) : status === "failed" ? (
            <CircleAlert />
          ) : (
            <MessageSquare />
          )}
        </button>
      )}
      {conversation && floatingState !== "collapsed" && (
        <header className="conversation-chat-heading">
          {floatingWindow && (
            <div className="floating-chat-titlebar">
              <button
                type="button"
                className="floating-chat-window-control"
                aria-label="Minimize chat"
                onClick={() => floatingWindow.onStateChange("collapsed")}
              >
                <Minus />
              </button>
              <ConnectionDot state={conn} />
              <span className="floating-chat-title" title={run.data?.goal}>
                <span>{run.data?.goal.split("\n")[0] || "New conversation"}</span>
              </span>
              {floatingWindow.menu}
            </div>
          )}
          <nav
            className="conversation-detail-tabs"
            aria-label="Conversation views"
          >
            <button
              aria-pressed={conversationTab === "chat"}
              onClick={() => setConversationTab("chat")}
            >
              <MessageSquare />
              Chat
            </button>
            <button
              aria-pressed={conversationTab === "tasks"}
              disabled={!runId}
              onClick={() => setConversationTab("tasks")}
            >
              <ListTodo />
              Tasks{" "}
              {!!Object.keys(state.tasks).length && (
                <span>{Object.keys(state.tasks).length}</span>
              )}
            </button>
            <button
              aria-pressed={conversationTab === "tools"}
              disabled={!runId}
              onClick={() => setConversationTab("tools")}
            >
              <Wrench />
              Tools
            </button>
            {(!!state.browser.length || browsing) && (
              <button
                aria-pressed={conversationTab === "browser"}
                onClick={() => setConversationTab("browser")}
              >
                <Globe className={cn(browsing && "animate-pulse text-success")} />
                Browser
              </button>
            )}
            <button
              aria-pressed={conversationTab === "report"}
              disabled={!runId || active}
              onClick={() => setConversationTab("report")}
            >
              <FileText />
              Recap
            </button>
          </nav>
          {runId && run.data && <RunStrip w={w} runId={runId} mode={run.data.mode} status={status} active={active} state={state} agents={agents} pending={control.isPending} onControl={(action) => control.mutate(action)} />}
        </header>
      )}
      {!conversation && (
        <header
          className={cn(
            "agent-panel-header flex h-11 shrink-0 items-center gap-2 border-b px-3",
            conversation && "conversation-toolbar",
          )}
        >
          {!conversation && <Bot className="h-4 w-4 text-primary" />}
          <span
            className={cn(
              "font-semibold",
              conversation ? "min-w-0 truncate text-sm" : "text-xs",
            )}
          >
            {conversation
              ? (run.data?.goal.split("\n")[0] ?? "New conversation")
              : "Octopus"}
          </span>
          <div className="ml-auto flex gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={
                conversation ? "Open code editor" : "Hide agent panel"
              }
              onClick={onClose}
            >
              {conversation ? <FileCode2 /> : <X />}
            </Button>
          </div>
        </header>
      )}
      {!conversation && runId && run.data && (
        <RunStrip w={w} runId={runId} mode={run.data.mode} status={status} active={active} state={state} agents={agents} pending={control.isPending} onControl={(action) => control.mutate(action)} />
      )}
      <div className="agent-message-area min-h-0 flex-1 overflow-hidden">
        {conversation && conversationTab !== "chat" ? (
          <div
            className="conversation-detail-panel h-full overflow-auto"
            aria-label={`${conversationTab} view`}
          >
            {conversationTab === "browser" && runId && (
              <div className="flex h-full flex-col"><BrowserView state={state} agents={agents} w={w} runId={runId} live={active} /></div>
            )}
            {conversationTab === "tasks" && (
              <TaskBoard tasks={Object.values(state.tasks)} agents={agents} compact />
            )}
            {conversationTab === "tools" && (
              <ToolLog state={state} agents={agents} />
            )}
            {conversationTab === "report" && runId && <ReportView w={w} runId={runId} enabled={!active} downloadable />}
          </div>
        ) : runId && run.isLoading ? (
          <p
            role="status"
            className="p-6 text-center text-sm text-muted-foreground"
          >
            Loading conversation…
          </p>
        ) : run.isError ? (
          <div role="alert" className="space-y-3 p-4 text-xs">
            <p>{run.error.message}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run.refetch()}
            >
              Try again
            </Button>
            <Button size="sm" variant="outline" onClick={newThread}>
              Start a new conversation
            </Button>
          </div>
        ) : runId && run.data ? (
          <div className="flex h-full flex-col">
            <div className="flex min-h-0 flex-1 flex-col">
              <RunFeed
                state={state}
                agents={agents}
                filter={internal ? "all" : "user"}
                showThoughts={false}
              />
            </div>
            {!conversation && !!Object.keys(state.artifacts).length && (
              <div className="max-h-28 shrink-0 overflow-auto border-t px-3 py-2">
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Changed files
                </p>
                {Object.values(state.artifacts)
                  .filter((a) => !a.path.startsWith(".octopus/"))
                  .map((a) => (
                    <button
                      key={a.path}
                      onClick={() => onOpen(a.path)}
                      disabled={a.deleted}
                      className="flex w-full items-center gap-2 py-1 text-left text-xs hover:text-primary"
                    >
                      <FileCode2 className="h-3 w-3" />
                      <span className="truncate">{a.path}</span>
                      {a.deleted && (
                        <span className="ml-auto text-destructive">
                          Deleted
                        </span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              "agent-empty flex h-full flex-col justify-center px-5 py-6",
              conversation && "conversation-empty",
            )}
          >
            <div
              className={cn(
                "mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10",
                conversation && "conversation-mark",
              )}
            >
              <img src="/octopus.svg" alt="" className="h-7 w-7" />
            </div>
            <h2
              className={
                conversation
                  ? "text-3xl font-medium tracking-tight"
                  : "text-base font-semibold"
              }
            >
              What are we building?
            </h2>
            <p
              className={cn(
                "mt-2 leading-relaxed text-muted-foreground",
                conversation ? "text-sm" : "text-xs",
              )}
            >
              Give your team a goal. Build something new, improve your project,
              or work through an idea.
            </p>
            {(!conversation || !!companyId) && (
              <div
                className={cn(
                  "mt-5",
                  conversation ? "conversation-suggestions" : "space-y-2",
                )}
              >
                {[
                  "Explain this project's architecture",
                  "Find and fix a bug in this project",
                  "Review my changes before I commit",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    className="w-full rounded-lg border bg-background/50 px-3 py-2.5 text-left text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    onClick={() => {
                      store.draft(key, prompt);
                      input.current?.focus();
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            {!companyId && (
              <Button
                className="mt-4"
                size="sm"
                onClick={() => setCreating(true)}
              >
                <Plus />
                Choose a custom team
              </Button>
            )}
            {!conversation && (
              <Link
                to={`/w/${w}/canvas`}
                className="mt-5 flex items-center gap-2 text-xs text-primary"
              >
                <Network className="h-3.5 w-3.5" />
                Design your team on the canvas
              </Link>
            )}
          </div>
        )}
      </div>
      {state.pendingApproval && (
        <div className="max-h-[45%] shrink-0 overflow-auto border-t p-2">
          <ApprovalCard
            key={`${state.pendingApproval.id}:${approval.isError}`}
            approval={state.pendingApproval}
            agent={agents[state.pendingApproval.agent_id]}
            onDecide={(approved, scope, reason) =>
              approval.mutate({ approved, scope, reason })
            }
          />
        </div>
      )}
      {state.awaiting && (
        <div className="max-h-[45%] shrink-0 overflow-auto border-t p-2">
          <QuestionCard
            key={state.awaiting.question}
            awaiting={state.awaiting}
            agent={agents[state.awaiting.agent_id]}
            onAnswer={(answer) =>
              submit.mutate({
                content: answer,
                contexts,
                files: attachments.files,
                clientId: crypto.randomUUID(),
              })
            }
          />
        </div>
      )}
      {floatingState !== "collapsed" &&
        (!conversation ||
          conversationTab === "chat" ||
          floatingState === "compose" ||
          floatingState === "minimized") && (
          <PromptComposer
            className={cn(
              "agent-composer",
              conversation && "conversation-composer",
            )}
            notice={
              <>
                {error && (
                  <p role="alert" className="mb-2 text-xs text-destructive">
                    {error}
                  </p>
                )}
                {(settings.isError || companiesQuery.isError) && (
                  <p role="alert" className="mb-2 text-xs text-destructive">
                    Conversation settings could not be loaded.{" "}
                    <button
                      className="underline"
                      onClick={() => {
                        void settings.refetch();
                        void companiesQuery.refetch();
                      }}
                    >
                      Try again
                    </button>
                  </p>
                )}
                {companyId && canvas.data?.agents.length === 0 && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    This team has no agents.{" "}
                    <Link className="underline" to={`/w/${w}/canvas`}>
                      Add an agent
                    </Link>{" "}
                    or choose another team.
                  </p>
                )}
                <div className="home-composer-context agent-composer-context">
                  <span className="home-project-trigger inline-flex items-center gap-1.5 text-sm">
                    <Folder />
                    <span>{ws.data?.name ?? "Project"}</span>
                    <ChevronDown />
                  </span>
                  <span className="home-computer-context">
                    <Laptop />
                    This computer
                  </span>
                  {conversationOptions}
                </div>
              </>
            }
            caption={
              <>
                <ShieldCheck className="h-3 w-3 shrink-0" />
                <span>{APPROVAL_MODES[approvalMode].caption}</span>
                <span className="ml-auto hidden shrink-0 sm:inline">
                  Enter to send
                </span>
              </>
            }
            controls={
              <>
                <Popover
                  open={adding}
                  onOpenChange={(open) => {
                    setAdding(open);
                    if (!open) setBrowsingFiles(false);
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Attach project file"
                      disabled={submit.isPending || attachments.uploading}
                    >
                      <Plus />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="composer-add-menu"
                  >
                    {!browsingFiles ? (
                      <>
                        <button
                          className="composer-add-item"
                          onClick={() => {
                            attachments.pick();
                            setAdding(false);
                          }}
                        >
                          <Paperclip />
                          <span>Add photos &amp; files</span>
                          <small>Upload from computer</small>
                        </button>
                        <button
                          className="composer-add-item"
                          onClick={() => setBrowsingFiles(true)}
                        >
                          <FileCode2 />
                          <span>Add project file</span>
                          <small>Browse files in this project</small>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="composer-add-back"
                          onClick={() => setBrowsingFiles(false)}
                        >
                          ← Back
                        </button>
                        <p className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">
                          Attach a project file
                        </p>
                        <input
                          aria-label="Find context file"
                          placeholder="Find a file…"
                          value={fileSearch}
                          onChange={(e) => setFileSearch(e.target.value)}
                          className="menu-search"
                        />
                        <div className="mt-1 max-h-52 overflow-auto">
                          {files
                            .filter((file) =>
                              file
                                .toLowerCase()
                                .includes(fileSearch.toLowerCase()),
                            )
                            .slice(0, 40)
                            .map((file) => (
                              <button
                                key={file}
                                onClick={() => add({ path: file })}
                                className="menu-file"
                              >
                                <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{file}</span>
                              </button>
                            ))}
                          {!files.some((file) =>
                            file
                              .toLowerCase()
                              .includes(fileSearch.toLowerCase()),
                          ) && (
                            <p className="px-2 py-4 text-xs text-muted-foreground">
                              No matching project files.
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </PopoverContent>
                </Popover>
                <ApprovalModePicker compact={!!floatingWindow} />
                {current && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Attach current file"
                    onClick={() => add({ path: current.path })}
                  >
                    <FileCode2 />
                    Current
                  </Button>
                )}
                {selection?.content && (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Attach selected code"
                    onClick={() => add(selection)}
                  >
                    Selection
                  </Button>
                )}
                <span className="flex-1" />
                <ModelPicker
                  compact={!!floatingWindow}
                  workspace={w}
                  value={runId ? recordedBudget : preferences}
                  locked={!!runId}
                  onChange={(value) =>
                    store.configure(w, { ...preferences, ...value })
                  }
                />
                <Button
                  size="icon"
                  className="composer-send"
                  aria-label={
                    floatingWindow && active && !text.trim()
                      ? "Stop team work"
                      : floatingWindow && active
                        ? "Queue message"
                        : active
                          ? "Send direction to agents"
                          : "Send agent message"
                  }
                  disabled={
                    floatingWindow && active && !text.trim()
                      ? control.isPending
                      : !canSubmit
                  }
                  loading={submit.isPending || control.isPending}
                  onClick={
                    floatingWindow && active && !text.trim()
                      ? () => control.mutate("stop")
                      : send
                  }
                >
                  {floatingWindow && active && !text.trim() ? (
                    <Square className="fill-current" />
                  ) : (
                    <ArrowUp />
                  )}
                </Button>
              </>
            }
          >
            {attachments.input}
            <AttachmentChips
              files={attachments.files}
              onRemove={submit.isPending ? undefined : attachments.remove}
            />
            {attachments.uploading && (
              <p role="status" className="text-xs text-muted-foreground">
                Attaching files…
              </p>
            )}
            {!companyId && !floatingWindow && (
              <p className="mb-2 text-xs text-muted-foreground">
                Your first message creates a coding agent. You can add a team
                later.
              </p>
            )}
            {!!contexts.length && (
              <div
                className="composer-attachments"
                aria-label="Attached code context"
              >
                {contexts.map((context, index) => (
                  <span
                    key={`${context.path}:${context.startLine}`}
                    className="composer-attachment"
                  >
                    <FileCode2 className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {context.path}
                      {context.startLine
                        ? `:${context.startLine}-${context.endLine}`
                        : ""}
                    </span>
                    <button
                      aria-label={`Remove context ${context.path}`}
                      onClick={() =>
                        setContexts((items) =>
                          items.filter((_, position) => position !== index),
                        )
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <Textarea
              ref={input}
              aria-label="Message the team lead"
              placeholder={
                floatingWindow
                  ? active
                    ? workingLabel
                    : "Work with Octopus"
                  : active
                    ? "Give the team direction…"
                    : runId
                      ? "Continue this conversation…"
                      : "Ask Octopus to build, fix, or explore…"
              }
              value={companyId ? text : (pendingPrompt ?? text)}
              maxLength={8000}
              rows={floatingWindow ? 1 : 2}
              onFocus={() => {
                if (floatingState === "minimized") {
                  changeFloatingState?.("compose");
                  setConversationTab("chat");
                }
              }}
              onChange={(event) => {
                if (floatingState === "minimized")
                  changeFloatingState?.("compose");
                if (companyId) store.draft(key, event.target.value);
                else store.stagePrompt(w, event.target.value);
              }}
              onPaste={submit.isPending ? undefined : attachments.onPaste}
              {...(submit.isPending ? {} : attachments.drop)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  send();
                }
              }}
            />
          </PromptComposer>
        )}
      <ConfirmDialog
        open={!!companyId && !!pendingPrompt && !!text.trim()}
        onOpenChange={(open) => {
          if (!open) store.discardPrompt(w);
        }}
        title="Replace the existing draft?"
        description="This project already has a message draft. Use the new prompt from Home, or cancel to keep your current draft."
        confirmLabel="Use new prompt"
        onConfirm={() => store.importPrompt(w, companyId, true)}
      />
      <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      <RunDialog
        open={advanced}
        onOpenChange={setAdvanced}
        companyId={companyId}
        initialGoal={text}
        initialSettings={preferences}
        onStarted={(r) => {
          store.selectThread(key, r.id);
          store.draft(key, "");
        }}
      />
    </section>
  );
}
