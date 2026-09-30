import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ChevronDown, Footprints, Paperclip, Play, ShieldCheck, Sparkles, X, Zap } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { qk, useSettings, useWorkspace, useWorkspaceId } from "@/hooks/queries";
import type { PermissionLevel, RunDetail } from "@/types";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/overlays";
import { PermissionPicker } from "@/features/workspaces/DirectoryPicker";
import { useAttachments, AttachmentChips } from "@/features/chat/attachments";

const MODES = [
  { v: "autonomous", label: "Autonomous", icon: Zap, d: "Runs until finished or a limit is hit" },
  { v: "step", label: "Step", icon: Footprints, d: "You click Next turn for every agent turn" },
  { v: "supervised", label: "Supervised", icon: ShieldCheck, d: "Pauses for approval at file writes and finish" },
] as const;

export function RunDialog({ open, onOpenChange, companyId, sessionId, initialGoal = "", onStarted }: {
  open: boolean; onOpenChange: (o: boolean) => void; companyId: string; sessionId?: string; initialGoal?: string; onStarted?: (r: RunDetail) => void;
}) {
  const w = useWorkspaceId();
  const ws = useWorkspace(w);
  const settings = useSettings();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [goal, setGoal] = React.useState(initialGoal);
  const [mode, setMode] = React.useState<(typeof MODES)[number]["v"]>("autonomous");
  const [perm, setPerm] = React.useState<PermissionLevel>((ws.data?.default_permission as PermissionLevel) ?? "ask");
  const anyConfigured = settings.data?.providers.some((p) => p.provider !== "mock" && p.configured) ?? false;
  const [demo, setDemo] = React.useState(!anyConfigured);
  const [adv, setAdv] = React.useState(false);
  const [budget, setBudget] = React.useState({ max_turns: 60, max_tokens: 400000, max_cost_usd: 2, timeout_s: 900, loop_threshold: 0.92, max_loop_strikes: 3, context_recent: 10, max_agents: 24, persist_team: true });
  const att = useAttachments();
  React.useEffect(() => { if (open) { setGoal(initialGoal); setPerm((ws.data?.default_permission as PermissionLevel) ?? "ask"); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => setDemo(!anyConfigured), [anyConfigured]);

  const start = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/runs", {
      params: { path: { workspace_id: w } },
      body: { company_id: companyId, goal: goal.trim(), session_id: sessionId, mode, permission_level: perm,
              budget: { ...budget, force_mock: demo }, attachments: att.files.map((f) => ({ filename: f.filename, text: f.text })) },
    })),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: qk.runs(w) });
      onOpenChange(false);
      att.clear();
      toast.success("Run started", { description: demo ? "Demo Mode: scripted, offline, free" : `${perm.replace("_", " ")} permissions` });
      if (onStarted) onStarted(r); else nav(`/w/${w}/runs/${r.id}`);
    },
    onError: (e: Error) => toast.error("Could not start run", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Play className="h-4 w-4 text-primary" />Run the company</DialogTitle>
          <DialogDescription>The goal goes to the entry agent(s), then flows along your channels.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Goal">
            <Textarea autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Build a todo app with auth" className="min-h-[84px]"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && goal.trim()) start.mutate(); }} data-testid="run-goal" />
            <div className="flex items-center gap-2 pt-1">
              <Button variant="ghost" size="xs" onClick={att.pick} loading={att.uploading}><Paperclip />Attach context</Button>
              <AttachmentChips files={att.files} onRemove={att.remove} />
              {att.input}
            </div>
          </Field>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Run mode">
            {MODES.map(({ v, label, icon: I, d }) => (
              <button key={v} role="radio" aria-checked={mode === v} onClick={() => setMode(v)}
                className={cn("rounded-lg border p-2.5 text-left transition-all hover:border-primary/50", mode === v ? "border-primary bg-primary/5" : "border-border")}>
                <div className="flex items-center gap-1.5 text-xs font-semibold"><I className="h-3.5 w-3.5 text-primary" />{label}</div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{d}</p>
              </button>
            ))}
          </div>
          <Field label="Permission level"><PermissionPicker value={perm} onChange={setPerm} compact /></Field>
          <label className={cn("flex items-center gap-3 rounded-lg border p-3 transition", demo ? "border-primary/40 bg-primary/5" : "border-border")}>
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="flex-1"><span className="block text-sm font-medium">Demo Mode</span><span className="block text-xs text-muted-foreground">Scripted, deterministic, offline agents (no API cost). Great for presentations.</span></span>
            <Switch checked={demo} onCheckedChange={setDemo} aria-label="Demo mode" />
          </label>
          <div>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdv(!adv)}>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", adv && "rotate-180")} />Limits & budget
            </button>
            {adv && (
              <div className="mt-2 grid grid-cols-4 gap-2 animate-fade-up">
                <Field label="Max turns"><Input type="number" value={budget.max_turns} onChange={(e) => setBudget({ ...budget, max_turns: +e.target.value || 1 })} className="h-8" /></Field>
                <Field label="Token budget"><Input type="number" value={budget.max_tokens} onChange={(e) => setBudget({ ...budget, max_tokens: +e.target.value || 1000 })} className="h-8" /></Field>
                <Field label="Cost cap ($)"><Input type="number" step="0.5" value={budget.max_cost_usd} onChange={(e) => setBudget({ ...budget, max_cost_usd: +e.target.value || 0 })} className="h-8" /></Field>
                <Field label="Timeout (s)"><Input type="number" value={budget.timeout_s} onChange={(e) => setBudget({ ...budget, timeout_s: +e.target.value || 60 })} className="h-8" /></Field>
                <Field label="Max team size" hint="Includes agents hired during the run"><Input type="number" min={1} max={100} value={budget.max_agents} onChange={(e) => setBudget({ ...budget, max_agents: Math.max(1, +e.target.value || 1) })} className="h-8" /></Field>
                <label className="col-span-3 flex items-center gap-2 self-end pb-1 text-xs">
                  <Switch checked={budget.persist_team} onCheckedChange={(v) => setBudget({ ...budget, persist_team: v })} aria-label="Save team changes" />
                  Save agents hired or edited during the run to the company (read-only and plan runs never save)
                </label>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground"><kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> to start</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}><X />Cancel</Button>
            <Button disabled={!goal.trim()} loading={start.isPending} onClick={() => start.mutate()} data-testid="start-run"><Play />Start run</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
