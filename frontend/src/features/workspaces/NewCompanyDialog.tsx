import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookmarkPlus, Building2, Check, Crown, LayoutTemplate, RefreshCw, Sparkles, Swords, Users, Wand2, FlaskConical, Rocket, Network, User } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { tone } from "@/lib/palette";
import { qk, useTemplates, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { CanvasOut, CompanyOut, TemplateOut } from "@/types";
import type { components } from "@/types/api.gen";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Slider, Textarea } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";

type Generated = components["schemas"]["GenerateCompanyOut"];
type DeptSummary = components["schemas"]["DepartmentSummary"];

const ICONS: Record<string, typeof Building2> = {
  software_startup: Rocket, full_company: Building2, self_organizing: Sparkles, research_lab: FlaskConical, small_dev_team: Users, debate_panel: Swords, blank: LayoutTemplate,
};
const EXAMPLES = [
  "Build and launch a habit-tracking mobile app, including a marketing campaign",
  "Research the impact of remote work on productivity and publish a report",
  "A GDPR-compliant SaaS invoicing platform deployed to the cloud",
];

export function DepartmentChips({ departments, max = 8 }: { departments: DeptSummary[]; max?: number }) {
  if (!departments.length) return <span className="text-[11px] text-muted-foreground">No departments</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {departments.slice(0, max).map((d0) => { const d = { ...d0, color: tone(d0.color) }; return (
        <span key={d.name} className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ background: `${d.color}1f`, color: d.color }}
          title={`${d.name}: ${[d.manager, ...d.members].filter(Boolean).join(", ")}`}>
          {d.name}<span className="opacity-70">{1 + d.members.length - (d.manager ? 0 : 1)}</span>
        </span>
      ); })}
      {departments.length > max && <span className="text-[10px] text-muted-foreground">+{departments.length - max}</span>}
    </div>
  );
}

export function OrgPreview({ departments }: { departments: DeptSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
      {departments.map((d0) => ({ ...d0, color: tone(d0.color) })).map((d) => (
        <div key={d.name} className="rounded-lg border p-2.5 animate-fade-up" style={{ borderColor: `${d.color}55`, background: `${d.color}0b` }}>
          <div className="mb-1.5 flex items-center justify-between text-xs font-semibold" style={{ color: d.color }}>
            <span>{d.name}</span><span className="text-[10px] font-normal text-muted-foreground">{(d.manager ? 1 : 0) + d.members.length} people</span>
          </div>
          {d.manager && <div className="flex items-center gap-1 text-xs"><Crown className="h-3 w-3 text-terracotta" />{d.manager}</div>}
          {d.members.map((m) => <div key={m} className="flex items-center gap-1 pl-0.5 text-xs text-muted-foreground"><User className="h-3 w-3" />{m}</div>)}
        </div>
      ))}
    </div>
  );
}

export function NewCompanyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void }) {
  const w = useWorkspaceId();
  const { data: templates, isLoading } = useTemplates();
  const [tab, setTab] = React.useState<"templates" | "generate">("templates");
  const [key, setKey] = React.useState("software_startup");
  const [name, setName] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [maxAgents, setMaxAgents] = React.useState(12);
  const [gen, setGen] = React.useState<Generated | null>(null);
  const qc = useQueryClient();
  const setCompany = useApp((s) => s.setCompany);
  const builtin = templates?.filter((t) => t.source === "builtin") ?? [];
  const mine = templates?.filter((t) => t.source === "user") ?? [];
  const tpl = templates?.find((t) => t.key === key);
  React.useEffect(() => { if (open) { setTab("templates"); setGen(null); } }, [open]);

  const done = (c: CanvasOut) => {
    qc.setQueryData(qk.canvas(w, c.company.id), c);
    // insert optimistically so the selector never falls back to another company while the list refetches
    qc.setQueryData<CompanyOut[]>(qk.companies(w), (old) => [c.company, ...(old ?? []).filter((x) => x.id !== c.company.id)]);
    setCompany(w, c.company.id);
    void qc.invalidateQueries({ queryKey: qk.companies(w) });
    toast.success(`${c.company.name} is ready`, { description: `${c.agents.length} agents in ${Object.keys(c.departments ?? {}).length} departments · ${c.edges.length} channels` });
    onOpenChange(false);
    setName(""); setGen(null);
    onCreated?.(c.company.id);
  };
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/companies/from-template", { params: { path: { workspace_id: w } }, body: { template_key: key, name: name.trim() || undefined } })),
    onSuccess: done,
  });
  const generate = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/companies/generate", { params: { path: { workspace_id: w } }, body: { prompt: prompt.trim(), max_agents: maxAgents } })),
    onSuccess: (g) => { setGen(g); if (g.warning) toast.warning(g.warning); },
  });
  const createGenerated = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/companies/import", { params: { path: { workspace_id: w } }, body: { ...gen!.spec, name: name.trim() || gen!.spec.name } })),
    onSuccess: done,
  });
  const saveGenerated = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/templates", { body: { name: name.trim() || gen!.spec.name, description: gen!.spec.description, spec: gen!.spec } })),
    onSuccess: (t) => { qc.invalidateQueries({ queryKey: ["templates"] }); toast.success(`Saved template "${t.name}"`); setTab("templates"); setKey(t.key); },
  });

  const card = (t: TemplateOut) => {
    const I = ICONS[t.key] ?? (t.source === "user" ? BookmarkPlus : LayoutTemplate);
    const active = t.key === key;
    return (
      <button key={t.key} role="radio" aria-checked={active} onClick={() => setKey(t.key)} onDoubleClick={() => create.mutate()} data-testid={`template-${t.key}`}
        className={cn("relative flex flex-col rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md",
          active ? "border-primary bg-primary/5 shadow-md shadow-primary/10" : "border-border")}>
        {active && <Check className="absolute right-2.5 top-2.5 h-4 w-4 text-primary animate-in zoom-in-50" />}
        <div className="mb-1.5 flex items-center gap-2"><I className="h-4 w-4 text-primary" /><span className="text-sm font-semibold">{t.name}</span>
          {t.source === "user" && <Badge variant="secondary">Mine</Badge>}</div>
        <div className="line-clamp-2 min-h-[2rem] text-xs text-muted-foreground">{t.description || "Custom template"}</div>
        <div className="mt-2"><DepartmentChips departments={t.departments ?? []} max={6} /></div>
        <div className="mt-1.5 text-[11px] text-muted-foreground">{t.agent_count} agents · {t.edge_count} channels</div>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>Companies are built from departments. Each has a manager and a small team. Everything stays editable, and managers can hire more agents at runtime.</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList><TabsTrigger value="templates"><LayoutTemplate />Templates</TabsTrigger><TabsTrigger value="generate" data-testid="tab-generate"><Wand2 />Generate with AI</TabsTrigger></TabsList>
          <TabsContent value="templates" className="mt-3 space-y-3">
            <div className="max-h-[48vh] space-y-3 overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" role="radiogroup" aria-label="Built-in templates">
                {isLoading && Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-36" />)}
                {builtin.map(card)}
              </div>
              {mine.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">My templates</div>
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" role="radiogroup" aria-label="My templates">{mine.map(card)}</div>
                </div>
              )}
            </div>
            <div className="flex items-end gap-2">
              <Field label="Company name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl?.name ?? "My company"} className="w-72" onKeyDown={(e) => e.key === "Enter" && create.mutate()} /></Field>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
                <Button loading={create.isPending} onClick={() => create.mutate()} data-testid="create-company"><Building2 />Create company</Button>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="generate" className="mt-3 space-y-3">
            <Field label="Describe the company you need" hint="An org designer (your configured model, or the offline designer in Demo Mode) proposes departments, managers, specialists, prompts, tools and channels.">
              <Textarea autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} className="min-h-[84px]" placeholder={EXAMPLES[0]} data-testid="generate-prompt"
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && prompt.trim().length > 2) generate.mutate(); }} />
            </Field>
            <div className="flex flex-wrap gap-1">{EXAMPLES.map((ex) => <button key={ex} onClick={() => setPrompt(ex)} className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-muted-foreground transition hover:border-primary/50 hover:text-foreground">{ex}</button>)}</div>
            <div className="flex items-center gap-4">
              <Field label={`Max team size: ${maxAgents}`}><Slider className="w-56" min={3} max={30} step={1} value={[maxAgents]} onValueChange={([v]) => setMaxAgents(v)} aria-label="Max team size" /></Field>
              <Button className="ml-auto" onClick={() => generate.mutate()} loading={generate.isPending} disabled={prompt.trim().length < 3} data-testid="generate">
                {gen ? <RefreshCw /> : <Wand2 />}{gen ? "Regenerate" : "Design company"}
              </Button>
            </div>
            {generate.isPending && <div className="grid grid-cols-3 gap-2">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-20" style={{ animationDelay: `${i * 90}ms` }} />)}</div>}
            {gen && !generate.isPending && (
              <div className="space-y-3 rounded-xl border border-border bg-surface p-3 animate-fade-up">
                <div className="flex items-center gap-2">
                  <Network className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold">{gen.spec.name}</span>
                  <Badge variant={gen.source === "ai" ? "default" : "secondary"}>{gen.source === "ai" ? "Designed by AI" : "Offline designer"}</Badge>
                  <span className="ml-auto text-[11px] text-muted-foreground">{gen.spec.agents.length} agents · {gen.spec.edges.length} channels</span>
                </div>
                <div className="max-h-[30vh] overflow-y-auto"><OrgPreview departments={gen.departments} /></div>
                <div className="flex items-end gap-2">
                  <Field label="Company name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={gen.spec.name} className="w-64" /></Field>
                  <div className="ml-auto flex gap-2">
                    <Button variant="outline" onClick={() => saveGenerated.mutate()} loading={saveGenerated.isPending}><BookmarkPlus />Save as template</Button>
                    <Button onClick={() => createGenerated.mutate()} loading={createGenerated.isPending} data-testid="create-generated"><Building2 />Create company</Button>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
