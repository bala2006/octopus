import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, FolderOpen, FolderX, Network, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { useWorkspaces, qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import type { PermissionLevel, WorkspaceOut } from "@/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Tip } from "@/components/ui/overlays";
import { PermissionBadge } from "@/components/common";
import { DirectoryPicker } from "./DirectoryPicker";

export function WelcomePage() {
  const { data, isLoading } = useWorkspaces();
  const [open, setOpen] = React.useState(false);
  const [forget, setForget] = React.useState<WorkspaceOut | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: id } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success("Removed from list. Files and .octopus data were kept."); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden p-6">
      <div className="pointer-events-none absolute inset-0 opacity-60 [background:radial-gradient(600px_circle_at_20%_10%,hsl(var(--primary)/0.15),transparent_60%),radial-gradient(500px_circle_at_90%_80%,rgba(6,182,212,0.12),transparent_60%)]" />
      <div className="relative w-full max-w-3xl space-y-8 animate-fade-up">
        <div className="flex items-center gap-4">
          <img src="/octopus.svg" alt="" className="h-14 w-14 drop-shadow-[0_8px_24px_rgba(139,92,246,0.35)]" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Octopus</h1>
            <p className="text-sm text-muted-foreground">Assemble a virtual company of AI agents that debate, delegate, review and ship real code in your project folder.</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: FolderOpen, t: "Pick a project folder", d: "Agents are sandboxed to it. Data is saved in .octopus/" },
            { icon: Network, t: "Wire your team", d: "Drag agents onto the canvas and connect who talks to whom" },
            { icon: ShieldCheck, t: "Stay in control", d: "Read-only, plan, ask or danger mode, plus live approvals" },
          ].map(({ icon: I, t, d }) => (
            <div key={t} className="rounded-xl border border-border bg-surface/70 p-3.5 backdrop-blur">
              <I className="mb-2 h-4 w-4 text-primary" />
              <div className="text-sm font-medium">{t}</div>
              <div className="text-xs text-muted-foreground">{d}</div>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-border bg-surface/80 backdrop-blur">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Projects</h2>
            <Button onClick={() => setOpen(true)} data-testid="open-folder"><FolderOpen />Open project folder</Button>
          </div>
          {isLoading ? (
            <div className="space-y-2 p-4">{[0, 1].map((i) => <div key={i} className="skeleton h-12" />)}</div>
          ) : !data?.length ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <Sparkles className="h-6 w-6 text-primary" />
              <p className="text-sm font-medium">Create your first workspace</p>
              <p className="max-w-sm text-xs text-muted-foreground">Choose an empty folder for a new app, or an existing repository you want your agent company to work on.</p>
              <Button className="mt-2" onClick={() => setOpen(true)}><FolderOpen />Choose directory</Button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((w) => (
                <li key={w.id} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30">
                  {w.exists ? <FolderOpen className="h-4 w-4 text-primary" /> : <FolderX className="h-4 w-4 text-destructive" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {w.name}
                      {!w.exists && <Tip content="The directory no longer exists"><AlertTriangle className="h-3.5 w-3.5 text-destructive" /></Tip>}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{w.path}</div>
                  </div>
                  <PermissionBadge level={w.default_permission as PermissionLevel} />
                  <span className="hidden w-20 text-right text-[11px] text-muted-foreground sm:block">{timeAgo(w.last_opened_at)}</span>
                  <Tip content="Remove from list (keeps files)">
                    <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100" aria-label={`Forget ${w.name}`} onClick={() => setForget(w)}><Trash2 /></Button>
                  </Tip>
                  <Button asChild size="sm" variant={w.exists ? "secondary" : "ghost"} disabled={!w.exists}>
                    <Link to={`/w/${w.id}/canvas`} aria-disabled={!w.exists}>Open<ArrowRight /></Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-center text-[11px] text-muted-foreground">Runs 100% locally · Azure OpenAI and Azure AI Foundry supported · Demo Mode works offline</p>
      </div>
      <DirectoryPicker open={open} onOpenChange={setOpen} />
      <ConfirmDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)} title={`Remove "${forget?.name}" from Octopus?`}
        description="The folder and its .octopus data stay on disk; you can re-open it any time to restore everything."
        confirmLabel="Remove" destructive onConfirm={() => forget && del.mutate(forget.id)} />
    </div>
  );
}
