import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Bot,
  CircleStop,
  FileCode2,
  History,
  Network,
  Pause,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
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
import type { AgentOut, PermissionLevel } from "@/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { Select, Tip } from "@/components/ui/overlays";
import { ConnectionDot } from "@/components/common";
import { Markdown } from "@/components/Markdown";
import { NewCompanyDialog } from "@/features/workspaces/NewCompanyDialog";
import { RunDialog } from "@/features/runs/RunDialog";
import { defaultRunBudget } from "@/features/runs/runDefaults";
import { RunFeed } from "@/features/runs/RunFeed";
import { ApprovalCard } from "@/features/runs/ApprovalCard";
import { QuestionCard } from "@/features/runs/QuestionCard";
import { useRunStream } from "@/features/runs/useRunStream";
import { TERMINAL } from "@/features/runs/runState";
import { useEditorStore } from "./editorStore";
import {
  contextGoal,
  modePermission,
  type AgentMode,
  type CodeContext,
} from "./agentContext";
import { threadKey, useWorkbenchStore } from "./workbenchStore";

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
}) {
  const { companyId } = useCompanyId();
  return (
    <CompanyAgentPanel
      key={`${workspace}/${companyId}`}
      workspace={workspace}
      companyId={companyId}
      current={current}
      selection={selection}
      selectionToken={selectionToken}
      onSelectionConsumed={onSelectionConsumed}
      files={files}
      onOpen={onOpen}
      onClose={onClose}
      focusToken={focusToken}
    />
  );
}

function CompanyAgentPanel({
  workspace: w,
  companyId,
  current,
  selection,
  selectionToken,
  onSelectionConsumed,
  files,
  onOpen,
  onClose,
  focusToken,
}: {
  workspace: string;
  companyId: string;
  current?: CodeContext;
  selection?: CodeContext;
  files: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
  focusToken: number;
  selectionToken: number;
  onSelectionConsumed?: () => void;
}) {
  const qc = useQueryClient();
  const { data: companies } = useCompanies(w);
  const { setCompanyId } = useCompanyId();
  const canvas = useCanvas(w, companyId);
  const ws = useWorkspace(w);
  const settings = useSettings();
  const runs = useRuns(w, companyId, true);
  const key = threadKey(w, companyId);
  const store = useWorkbenchStore();
  const selected = store.threads[key];
  const runId = companyId
    ? selected === undefined
      ? runs.data?.[0]?.id
      : (selected ?? undefined)
    : undefined;
  const run = useRun(w, runId ?? "");
  const base =
    (run.data?.snapshot?.agents as AgentOut[] | undefined) ??
    canvas.data?.agents ??
    [];
  const names = React.useMemo(
    () => Object.fromEntries(base.map((a) => [a.id, a.name])),
    [base],
  );
  const { state, conn } = useRunStream(w, run.data ? runId : undefined, names);
  const agents = Object.fromEntries(
    [...base, ...state.extraAgents].map((a) => [
      a.id,
      { ...a, ...state.agentPatches[a.id] },
    ]),
  );
  const status =
    state.replayDone || state.live ? state.status : run.data?.status;
  const active = !!runId && !!status && !TERMINAL.has(status);
  const text = store.drafts[key] ?? "";
  const [mode, setMode] = React.useState<AgentMode>("agent");
  const [contexts, setContexts] = React.useState<CodeContext[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [fileSearch, setFileSearch] = React.useState("");
  const [history, setHistory] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [internal, setInternal] = React.useState(false);
  const [error, setError] = React.useState("");
  const input = React.useRef<HTMLTextAreaElement>(null);
  const configured = !!settings.data?.providers.some(
    (p) => p.provider !== "mock" && p.configured,
  );
  const permission = modePermission(
    mode,
    (ws.data?.default_permission ?? "ask") as PermissionLevel,
  );
  React.useEffect(() => {
    if (focusToken) input.current?.focus();
  }, [focusToken]);
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
    mutationFn: async (instruction: string) => {
      const context = await Promise.all(
        contexts.map(async (c) => {
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
      const goal = contextGoal(instruction, context);
      if (runId) {
        await unwrap(
          api.POST("/api/v1/w/{workspace_id}/runs/{run_id}/interject", {
            params: { path: { workspace_id: w, run_id: runId } },
            body: { content: goal },
          }),
        );
        return runId;
      }
      const result = await unwrap(
        api.POST("/api/v1/w/{workspace_id}/runs", {
          params: { path: { workspace_id: w } },
          body: {
            company_id: companyId,
            goal,
            mode: "autonomous",
            permission_level: permission,
            budget: {
              ...defaultRunBudget(),
              force_mock: !configured,
              workflow: mode === "ask" ? "off" : "auto",
            },
          },
        }),
      );
      return result.id;
    },
    onMutate: () => setError(""),
    onSuccess: (id, submitted) => {
      store.selectThread(key, id);
      if (useWorkbenchStore.getState().drafts[key] === submitted)
        store.draft(key, "");
      setContexts([]);
      void qc.invalidateQueries({ queryKey: qk.runs(w) });
      void qc.invalidateQueries({ queryKey: qk.run(w, id) });
    },
    onError: (e: Error) => setError(e.message),
  });
  const control = useMutation({
    mutationFn: (action: "pause" | "resume" | "stop") =>
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
    !!companyId &&
    !!text.trim() &&
    !submit.isPending &&
    !run.isLoading &&
    (!runId || !!run.data);
  const send = () => {
    if (canSubmit) submit.mutate(text);
  };
  const newThread = () => {
    store.selectThread(key, null);
    setHistory(false);
    setContexts([]);
    setError("");
    input.current?.focus();
  };
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface/30"
      aria-label="Agent workbench"
      data-testid="agent-workbench"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <Bot className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold">Octopus</span>
        <select
          aria-label="Agent company"
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          className="min-w-0 max-w-44 flex-1 truncate bg-transparent text-[11px] text-muted-foreground"
        >
          {!companyId && <option value="">Your team</option>}
          {companies?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="ml-auto flex gap-0.5">
          <Tip content="Conversation history">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Agent conversation history"
              aria-pressed={history}
              onClick={() => setHistory(!history)}
            >
              <History />
            </Button>
          </Tip>
          <Tip content="New conversation">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New agent conversation"
              onClick={newThread}
              disabled={submit.isPending}
            >
              <Plus />
            </Button>
          </Tip>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Hide agent panel"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </header>
      {history && (
        <div
          className="max-h-52 shrink-0 overflow-auto border-b p-2"
          aria-label="Agent conversations"
        >
          {runs.isError && (
            <p role="alert" className="p-2 text-xs text-destructive">
              {runs.error.message}
            </p>
          )}
          {!runs.data?.length && (
            <p className="p-2 text-xs text-muted-foreground">
              No conversations yet.
            </p>
          )}
          {runs.data?.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                store.selectThread(key, r.id);
                setHistory(false);
                setError("");
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent",
                r.id === runId && "bg-accent",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {r.goal.split("\n")[0]}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {r.status.replace("_", " ")}
              </span>
            </button>
          ))}
        </div>
      )}
      {runId && run.data && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[11px]">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              active ? "bg-primary" : "bg-success",
            )}
          />
          <span className="capitalize">{status?.replace("_", " ")}</span>
          <ConnectionDot state={conn} />
          <Link
            to={`/w/${w}/runs/${runId}`}
            className="ml-auto text-muted-foreground hover:text-primary"
          >
            Full run
          </Link>
          {active && (
            <>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={
                  status === "paused" ? "Resume agent run" : "Pause agent run"
                }
                disabled={control.isPending}
                onClick={() =>
                  control.mutate(status === "paused" ? "resume" : "pause")
                }
              >
                {status === "paused" ? <Play /> : <Pause />}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Stop agent run"
                disabled={control.isPending}
                onClick={() => control.mutate("stop")}
              >
                <CircleStop />
              </Button>
            </>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {run.isError ? (
          <div role="alert" className="space-y-3 p-4 text-xs">
            <p>{run.error.message}</p>
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
            {!!Object.keys(state.artifacts).length && (
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
                      className="flex w-full items-center gap-2 py-1 text-left text-xs hover:text-primary"
                    >
                      <FileCode2 className="h-3 w-3" />
                      <span className="truncate">{a.path}</span>
                      {a.planned && (
                        <span className="ml-auto text-warning">Planned</span>
                      )}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col justify-center px-5 py-6">
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-base font-semibold">Build with your team.</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Describe a change, attach the relevant code, and let your company
              plan, implement, and verify it alongside your editor.
            </p>
            <div className="mt-5 space-y-2">
              {[
                "Explain this project's architecture",
                "Find and fix a bug with a regression test",
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
            {!companyId && (
              <Button
                className="mt-4"
                size="sm"
                onClick={() => setCreating(true)}
              >
                <Plus />
                Create a company
              </Button>
            )}
            <Link
              to={`/w/${w}/canvas`}
              className="mt-5 flex items-center gap-2 text-xs text-primary"
            >
              <Network className="h-3.5 w-3.5" />
              Design your team on the canvas
            </Link>
          </div>
        )}
      </div>
      {state.summary && TERMINAL.has(status ?? "") && (
        <details className="max-h-40 shrink-0 overflow-auto border-t px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium">Run summary</summary>
          <Markdown className="pt-2 text-xs">{state.summary}</Markdown>
        </details>
      )}
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
            onAnswer={(answer) => submit.mutate(answer)}
          />
        </div>
      )}
      <div className="shrink-0 border-t p-3">
        {error && (
          <p role="alert" className="mb-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="rounded-xl border bg-background p-2.5 shadow-sm focus-within:border-primary/60">
          {!!contexts.length && (
            <div
              className="mb-2 flex flex-wrap gap-1"
              aria-label="Attached code context"
            >
              {contexts.map((c, i) => (
                <span
                  key={`${c.path}:${c.startLine}`}
                  className="flex max-w-full items-center gap-1 rounded-md border bg-surface px-1.5 py-1 text-[10px]"
                >
                  <FileCode2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {c.path}
                    {c.startLine ? `:${c.startLine}-${c.endLine}` : ""}
                  </span>
                  <button
                    aria-label={`Remove context ${c.path}`}
                    onClick={() =>
                      setContexts((items) => items.filter((_, n) => i !== n))
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
            aria-label="Message your company"
            placeholder={
              active
                ? "Give the team direction…"
                : runId
                  ? "Continue this conversation…"
                  : "Ask Octopus to build, fix, or explain…"
            }
            value={text}
            maxLength={8000}
            rows={3}
            className="min-h-[72px] resize-none border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
            onChange={(e) => store.draft(key, e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="mt-2 flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              aria-label="Attach project file"
              aria-expanded={adding}
              onClick={() => setAdding(!adding)}
            >
              @ Files
            </Button>
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
            <Button
              size="icon-sm"
              className="ml-auto"
              aria-label={
                active ? "Send direction to agents" : "Send agent message"
              }
              disabled={!canSubmit}
              loading={submit.isPending}
              onClick={send}
            >
              <ArrowUp />
            </Button>
          </div>
          {adding && (
            <div className="mt-2 rounded-md border p-1.5">
              <input
                aria-label="Find context file"
                autoFocus
                placeholder="Find a file…"
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                className="w-full border-b bg-transparent px-1 pb-1.5 text-xs outline-none"
              />
              <div className="max-h-32 overflow-auto">
                {files
                  .filter((f) =>
                    f.toLowerCase().includes(fileSearch.toLowerCase()),
                  )
                  .slice(0, 40)
                  .map((f) => (
                    <button
                      key={f}
                      onClick={() => add({ path: f })}
                      className="block w-full truncate rounded px-1 py-1.5 text-left text-[11px] hover:bg-accent"
                    >
                      {f}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
          {runId ? (
            <span className="flex items-center gap-1">
              <ShieldCheck className="h-3 w-3" />
              {run.data?.permission_level?.replace("_", " ") ?? "Loading"}
            </span>
          ) : (
            <div className="w-24">
              <Select
                ariaLabel="Agent mode"
                value={mode}
                onValueChange={(v) => setMode(v as AgentMode)}
                options={[
                  {
                    value: "agent",
                    label: "Agent",
                    hint: "Implement and verify changes",
                  },
                  {
                    value: "plan",
                    label: "Plan",
                    hint: "Propose changes without writing your files",
                  },
                  {
                    value: "ask",
                    label: "Ask",
                    hint: "Read and explain, without edits or commands",
                  },
                ]}
              />
            </div>
          )}
          <span className="truncate">
            {configured ? "Connected model" : "Offline demo"}
          </span>
          <button
            className="ml-auto hover:text-foreground"
            onClick={() => setInternal(!internal)}
            aria-pressed={internal}
          >
            {internal ? "Team feed" : "Replies"}
          </button>
          <Tip content="Run settings and limits">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Agent run settings"
              disabled={!companyId}
              onClick={() => setAdvanced(true)}
            >
              <Settings2 />
            </Button>
          </Tip>
        </div>
        {!runId && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {permission === "read_only"
              ? "Read only · no edits or commands"
              : permission === "plan"
                ? "Plan only · project files stay unchanged"
                : permission === "danger"
                  ? "Full access · commands and edits run without approval"
                  : "Edits and commands require your approval"}{" "}
            · Enter to send
          </p>
        )}
      </div>
      <NewCompanyDialog open={creating} onOpenChange={setCreating} />
      <RunDialog
        open={advanced}
        onOpenChange={setAdvanced}
        companyId={companyId}
        initialGoal={text}
        onStarted={(r) => {
          store.selectThread(key, r.id);
          store.draft(key, "");
        }}
      />
    </section>
  );
}
