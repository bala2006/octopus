import * as React from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, BookOpen, CheckCircle2, FolderOpen, FolderX, ImagePlus, MonitorPlay, Network, Play, Search, ShieldCheck, Trash2,
} from "lucide-react";
import { useWorkspaces, qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import type { PermissionLevel, WorkspaceOut } from "@/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Tip } from "@/components/ui/overlays";
import { PermissionBadge } from "@/components/common";
import { useOpenFolder } from "./useOpenFolder";

const FEATURES = [
  { icon: CheckCircle2, t: "Builds, runs and checks its work", d: "Every file is syntax-checked as it's written; agents run their code and open it in a real browser before they report done." },
  { icon: MonitorPlay, t: "Watch it live", d: "See each agent's actual browser tab as it works, and take control with your own mouse and keyboard." },
  { icon: ImagePlus, t: "Show, don't describe", d: "Paste a screenshot or mock-up into the goal; every agent sees the image." },
  { icon: ShieldCheck, t: "You stay in charge", d: "Permission levels, approvals for risky steps, and every change kept as a revertible version." },
];

const STEPS = [
  { icon: FolderOpen, t: "Open a folder", d: "An empty folder for something new, or an existing repo. Agents can't leave it." },
  { icon: Network, t: "Pick a team", d: "Start from a template or describe the company you want; change anyone later." },
  { icon: Play, t: "Give it a goal", d: "Type it, paste screenshots, and watch the team build it." },
];

function initials(name: string): string {
  const parts = name.replace(/[-_.]+/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

export function WelcomePage() {
  const { data, isLoading } = useWorkspaces();
  const folder = useOpenFolder();
  const [forget, setForget] = React.useState<WorkspaceOut | null>(null);
  const [q, setQ] = React.useState("");
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: id } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success("Removed from list. Files and .octopus data were kept."); },
    onError: (e: Error) => toast.error(e.message),
  });
  const projects = React.useMemo(() => {
    const all = [...(data ?? [])].sort((a, b) => String(b.last_opened_at ?? "").localeCompare(String(a.last_opened_at ?? "")));
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((w) => `${w.name} ${w.display_path || w.path}`.toLowerCase().includes(needle)) : all;
  }, [data, q]);
  const hasProjects = !!data?.length;

  return (
    <div className="relative h-full overflow-y-auto">
      {/* soft brand glow behind the hero */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.16),transparent_65%)]" />
      <header className="relative mx-auto flex max-w-6xl items-center gap-2 px-6 py-4">
        <img src="/octopus.svg" alt="" className="h-7 w-7" />
        <span className="text-sm font-semibold tracking-tight">Octopus</span>
        <span className="ml-auto" />
        <Button size="sm" variant="ghost" asChild><Link to="/guide"><BookOpen />Guide</Link></Button>
      </header>

      <main className="relative mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 pb-12 pt-6 lg:grid-cols-[1.05fr_1fr] lg:pt-12 animate-fade-up">
        {/* left: what Octopus is */}
        <section className="min-w-0 space-y-7">
          <div className="space-y-4">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />Runs locally, on your files
            </span>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-[2.75rem]">
              A team of AI agents that <span className="text-primary">ships working software</span> into your folder
            </h1>
            <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">
              Give it a goal. Octopus puts the right agents on it, has them build in a real project folder, run what they build
              and check it in a browser, and shows you every step as it happens.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="lg" onClick={folder.open} loading={folder.busy} data-testid="open-folder"><FolderOpen />Open project folder</Button>
              <Button size="lg" variant="outline" asChild><Link to="/guide"><BookOpen />How it works</Link></Button>
            </div>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2">
            {FEATURES.map(({ icon: I, t, d }) => (
              <li key={t} className="rounded-xl border border-border/70 bg-card/60 p-3.5">
                <div className="flex items-center gap-2 text-sm font-medium"><I className="h-4 w-4 shrink-0 text-primary" />{t}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{d}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* right: projects (or how to start) */}
        <section className="flex min-h-0 min-w-0 flex-col self-start rounded-2xl border border-border bg-card shadow-sm lg:max-h-[640px]" aria-label="Your projects">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">{hasProjects ? "Recent projects" : "Get started"}</h2>
            {hasProjects && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{data!.length}</span>}
            {hasProjects && <Button size="sm" variant="outline" className="ml-auto" onClick={folder.open}><FolderOpen />Open folder</Button>}
          </div>
          {isLoading ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-12" />)}</div>
          ) : !hasProjects ? (
            <div className="space-y-4 p-5">
              <div className="text-center">
                <p className="text-sm font-medium">Create your first workspace</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Three steps, about a minute. Works offline in Demo Mode.</p>
              </div>
              <ol className="space-y-2">
                {STEPS.map(({ icon: I, t, d }, i) => (
                  <li key={t} className="flex gap-3 rounded-xl border border-border/70 p-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><I className="h-4 w-4" /></span>
                    <div><div className="text-sm font-medium"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">0{i + 1}</span>{t}</div>
                      <div className="text-xs leading-relaxed text-muted-foreground">{d}</div></div>
                  </li>
                ))}
              </ol>
              <Button className="w-full" onClick={folder.open} loading={folder.busy}><FolderOpen />Open project folder</Button>
            </div>
          ) : (
            <>
              {data!.length > 5 && (
                <div className="border-b border-border px-3 py-2">
                  <label className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs focus-within:border-primary/50">
                    <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter projects" className="w-full bg-transparent outline-none" aria-label="Filter projects" />
                  </label>
                </div>
              )}
              <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                {projects.map((w) => (
                  <li key={w.id} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30">
                    <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold",
                      w.exists ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")}>
                      {w.exists ? initials(w.name) : <FolderX className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {w.exists ? <Link to={`/w/${w.id}/canvas`} className="truncate after:absolute after:inset-0 hover:underline">{w.name}</Link> : <span className="truncate">{w.name}</span>}
                        {!w.exists && <Tip content="The directory no longer exists"><AlertTriangle className="h-3.5 w-3.5 text-destructive" /></Tip>}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{w.display_path || w.path}</div>
                    </div>
                    <div className="relative z-10 hidden flex-col items-end gap-1 sm:flex">
                      <PermissionBadge level={w.default_permission as PermissionLevel} />
                      <span className="text-[10px] text-muted-foreground">{timeAgo(w.last_opened_at)}</span>
                    </div>
                    <Tip content="Remove from list (keeps files)">
                      <Button variant="ghost" size="icon-sm" className="relative z-10 opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Forget ${w.name}`} onClick={() => setForget(w)}><Trash2 /></Button>
                    </Tip>
                    <ArrowRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5", !w.exists && "opacity-0")} />
                  </li>
                ))}
                {!projects.length && <li className="p-6 text-center text-xs text-muted-foreground">No project matches “{q}”.</li>}
              </ul>
            </>
          )}
        </section>
      </main>
      <footer className="relative pb-6 text-center text-[11px] text-muted-foreground">
        Runs locally · Works offline in Demo Mode · Connect Azure OpenAI or another model any time in Settings
      </footer>
      {folder.element}
      <ConfirmDialog open={!!forget} onOpenChange={(o) => !o && setForget(null)} title={`Remove "${forget?.name}" from Octopus?`}
        description="The folder and its .octopus data stay on disk; you can re-open it any time to restore everything."
        confirmLabel="Remove" destructive onConfirm={() => forget && del.mutate(forget.id)} />
    </div>
  );
}
