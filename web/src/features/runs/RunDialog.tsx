import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  ChevronDown,
  Footprints,
  Paperclip,
  Play,
  X,
  Zap,
} from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { qk, useWorkspaceId } from "@/hooks/queries";
import type { ParsedFileOut, RunDetail } from "@/types";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/overlays";
import { EffortPicker } from "@/features/canvas/EffortPicker";
import { defaultRunBudget } from "./runDefaults";
import {
  useAttachments,
  AttachmentChips,
  attachmentPayload,
} from "@/features/chat/attachments";
import { ModelPicker } from "@/features/conversation/ModelPicker";
import type { ComposerSettings } from "@/features/conversation/workbenchStore";

const MODES = [
  {
    v: "autonomous",
    label: "Autonomous",
    icon: Zap,
    d: "The team works until the request is done or a limit is reached",
  },
  {
    v: "step",
    label: "Step",
    icon: Footprints,
    d: "The team pauses after every model call until you press Next step",
  },
] as const;

export function RunDialog({
  open,
  onOpenChange,
  companyId,
  sessionId,
  initialGoal = "",
  initialAttachments,
  initialSettings,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  companyId: string;
  sessionId?: string;
  initialGoal?: string;
  /** e.g. files and screenshots already attached in the channel composer */
  initialAttachments?: ParsedFileOut[];
  onStarted?: (r: RunDetail) => void;
  initialSettings?: ComposerSettings;
}) {
  const w = useWorkspaceId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [goal, setGoal] = React.useState(initialGoal);
  const [mode, setMode] =
    React.useState<(typeof MODES)[number]["v"]>("autonomous");
  const [adv, setAdv] = React.useState(false);
  const [budget, setBudget] = React.useState(defaultRunBudget);
  const att = useAttachments({ images: true });
  React.useEffect(() => {
    if (!open) return;
    setGoal(initialGoal);
    if (initialSettings)
      setBudget((current) => ({
        ...current,
        model: initialSettings.model,
        reasoning_effort: initialSettings.reasoning_effort,
      }));
    if (initialAttachments?.length) att.setFiles(initialAttachments);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/w/{workspace_id}/runs", {
          params: { path: { workspace_id: w } },
          body: {
            company_id: companyId,
            goal: goal.trim(),
            session_id: sessionId,
            mode,
            budget,
            attachments: attachmentPayload(att.files),
          },
        }),
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: qk.runs(w) });
      onOpenChange(false);
      att.clear();
      toast.success("Team conversation started");
      if (onStarted) onStarted(r);
      else nav(`/w/${w}/runs/${r.id}`);
    },
    onError: (e: Error) =>
      toast.error("Could not start run", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-primary" />
            Start a team conversation
          </DialogTitle>
          <DialogDescription>
            Octopus plans the work, assigns it to the team, has every change reviewed and checked, and reports back. Set limits for this conversation below.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field
            label="Goal"
            hint="Paste screenshots (Ctrl+V) or drop images and files here; agents see images as images."
          >
            <div {...att.drop}>
              <Textarea
                autoFocus
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Build a todo app with auth"
                className="min-h-[84px]"
                onPaste={att.onPaste}
                onKeyDown={(e) => {
                  if (
                    (e.metaKey || e.ctrlKey) &&
                    e.key === "Enter" &&
                    goal.trim()
                  )
                    start.mutate();
                }}
                data-testid="run-goal"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={att.pick}
                loading={att.uploading}
                data-testid="attach-button"
              >
                <Paperclip />
                Attach files or images
              </Button>
              <AttachmentChips files={att.files} onRemove={att.remove} />
              {att.input}
            </div>
          </Field>
          <button
            type="button"
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setAdv(!adv)}
            aria-expanded={adv}
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                adv && "rotate-180",
              )}
            />
            {adv
              ? "Hide advanced execution settings"
              : "Advanced execution settings"}
          </button>
          {adv && (
            <>
              <div
                className="grid grid-cols-2 gap-2"
                role="radiogroup"
                aria-label="Run mode"
              >
                {MODES.map(({ v, label, icon: I, d }) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={mode === v}
                    onClick={() => setMode(v)}
                    className={cn(
                      "rounded-lg border p-2.5 text-left transition-all hover:border-primary/50",
                      mode === v
                        ? "border-primary bg-primary/5"
                        : "border-border",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <I className="h-3.5 w-3.5 text-primary" />
                      {label}
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      {d}
                    </p>
                  </button>
                ))}
              </div>
              <Field
                label="Reasoning effort"
                hint="Applies to every agent in this run. “Per agent” uses each agent's own setting."
              >
                <EffortPicker
                  value={budget.reasoning_effort}
                  defaultLabel="Per agent"
                  onChange={(v) =>
                    setBudget({ ...budget, reasoning_effort: v })
                  }
                />
              </Field>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <ModelPicker
              workspace={w}
              value={budget}
              onChange={(value) =>
                setBudget((current) => ({ ...current, ...value }))
              }
            />
          </div>
          <div>
            {adv && (
              <div className="mt-2 grid grid-cols-4 gap-2 animate-fade-up">
                <Field label="Max model calls">
                  <Input
                    type="number"
                    min={1}
                    max={2000}
                    value={budget.max_turns}
                    onChange={(e) => setBudget({ ...budget, max_turns: Math.min(2000, Math.max(1, +e.target.value || 1)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Token budget">
                  <Input
                    type="number"
                    min={1000}
                    max={50000000}
                    value={budget.max_tokens}
                    onChange={(e) => setBudget({ ...budget, max_tokens: Math.min(50000000, Math.max(1000, +e.target.value || 1000)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Cost cap ($)">
                  <Input
                    type="number"
                    min={0}
                    max={1000}
                    step="0.5"
                    value={budget.max_cost_usd}
                    onChange={(e) => setBudget({ ...budget, max_cost_usd: Math.min(1000, Math.max(0, +e.target.value || 0)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Active time (s)" hint="Seconds of agent work; paused or waiting-for-you time does not count">
                  <Input
                    type="number"
                    min={30}
                    max={86400}
                    value={budget.timeout_s}
                    onChange={(e) => setBudget({ ...budget, timeout_s: Math.min(86400, Math.max(30, +e.target.value || 30)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Parallel tasks" hint="How many specialists work at the same time">
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    value={budget.max_concurrency}
                    onChange={(e) => setBudget({ ...budget, max_concurrency: Math.min(8, Math.max(1, +e.target.value || 1)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Max team size" hint="Includes people hired during the conversation">
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={budget.max_agents}
                    onChange={(e) => setBudget({ ...budget, max_agents: Math.min(60, Math.max(1, +e.target.value || 1)) })}
                    className="h-8"
                  />
                </Field>
                <Field label="Fix rounds" hint="Rounds of review changes and failed checks before the team stops">
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    value={budget.max_revisions}
                    onChange={(e) => setBudget({ ...budget, max_revisions: Math.min(5, Math.max(0, +e.target.value || 0)) })}
                    className="h-8"
                  />
                </Field>
                <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs">
                  <Switch checked={budget.review} onCheckedChange={(v) => setBudget({ ...budget, review: v })} aria-label="Independent review" />
                  Independent review: a second specialist reviews every change
                </label>
                <label className="col-span-2 flex items-center gap-2 self-end pb-1 text-xs">
                  <Switch checked={budget.verify} onCheckedChange={(v) => setBudget({ ...budget, verify: v })} aria-label="Run project checks" />
                  Run the project&apos;s tests and checks after changes
                </label>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">
            <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> to
            start
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              <X />
              Cancel
            </Button>
            <Button
              disabled={!goal.trim() || att.uploading}
              loading={start.isPending}
              onClick={() => start.mutate()}
              data-testid="start-run"
            >
              <Play />
              Start conversation
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
