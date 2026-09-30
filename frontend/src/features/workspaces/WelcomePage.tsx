import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, BookOpen, FolderOpen, FolderX, Network, Play, Sparkles, Trash2 } from "lucide-react";
import { useWorkspaces, qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/utils";
import type { PermissionLevel, WorkspaceOut } from "@/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Tip } from "@/components/ui/overlays";
import { PermissionBadge } from "@/components/common";
import { useOpenFolder } from "./useOpenFolder";

export function WelcomePage() {
  const { data, isLoading } = useWorkspaces();
  const folder = useOpenFolder();
  const [forget, setForget] = React.useState<WorkspaceOut | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: id } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success("Removed from list. Files and .octopus data were kept."); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex h-full justify-center overflow-y-auto p-6">
      <div className="relative my-auto w-full max-w-3xl space-y-8 py-6 animate-fade-up">
        <div className="space-y-3 text-center">
          <img src="/octopus.svg" alt="" className="mx-auto h-14 w-14" />
          <h1 className="text-3xl font-semibold tracking-tight">Your AI company, in one folder</h1>
          <p className="mx-auto max-w-xl text-[15px] text-muted-foreground">
            Octopus builds a small team of AI agents (a CEO, engineers, a reviewer…) that plan, talk to each other and write real files in a project folder you choose.
          </p>
          <div className="flex justify-center gap-2 pt-1">
            <Button size="lg" onClick={folder.open} loading={folder.busy} data-testid="open-folder"><FolderOpen />Open project folder</Button>
            <Button size="lg" variant="outline" asChild><Link to="/guide"><BookOpen />How it works</Link></Button>
          </div>
        </div>

        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: FolderOpen, t: "Pick a folder", d: "An empty folder for a new app, or an existing repo. Agents can't leave it." },
            { icon: Network, t: "Choose a team", d: "Start from a template. Every agent and connection can be changed later." },
            { icon: Play, t: "Give it a goal", d: "Watch the team work live. You approve risky steps and review every file." },
          ].map(({ icon: I, t, d }, i) => (
            <li key={t} className="relative rounded-2xl border border-border bg-card p-4">
              <span className="absolute right-3 top-3 font-mono text-xs text-muted-foreground">0{i + 1}</span>
              <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><I className="h-4 w-4" /></span>
              <div className="text-sm font-semibold">{t}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{d}</div>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Your projects</h2>
            {!!data?.length && <Button size="sm" variant="outline" onClick={folder.open}><FolderOpen />Open another folder</Button>}
          </div>
          {isLoading ? (
            <div className="space-y-2 p-4">{[0, 1].map((i) => <div key={i} className="skeleton h-12" />)}</div>
          ) : !data?.length ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <Sparkles className="h-6 w-6 text-primary" />
              <p className="text-sm font-medium">Create your first workspace</p>
              <p className="max-w-sm text-xs text-muted-foreground">No projects yet. Use <b>Open project folder</b> above to get started.</p>
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
        <p className="text-center text-[11px] text-muted-foreground">Runs locally · Works offline in Demo Mode · Connect Azure OpenAI or another model any time in Settings</p>
      </div>
      {folder.element}
      <ConfirmDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)} title={`Remove "${forget?.name}" from Octopus?`}
        description="The folder and its .octopus data stay on disk; you can re-open it any time to restore everything."
        confirmLabel="Remove" destructive onConfirm={() => forget && del.mutate(forget.id)} />
    </div>
  );
}
