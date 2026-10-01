/** Settings → Skills: step-by-step playbooks agents load when they start a kind of work (Agent Skills / SKILL.md format).
 * Edit the built-in ones (and restore their defaults) or write your own. Projects can add more in .octopus/skills,
 * .agents/skills or .claude/skills. */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpenCheck, Plus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRoleTemplates, useSkills } from "@/hooks/queries";
import type { SkillOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";
import { Combobox } from "@/components/ui/combobox";
import { roleOptions } from "@/features/canvas/roleHelpers";

type Draft = { name: string; description: string; body: string; roles: string[]; phases: string[] };
const draftOf = (s: SkillOut): Draft => ({ name: s.name, description: s.description, body: s.body, roles: [...(s.roles ?? [])], phases: [...(s.phases ?? [])] });
export const PHASES = ["intake", "research", "spec", "design", "build", "test", "review", "accept"];
export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 62);

export function SkillsSection() {
  const { data: skills = [], isLoading } = useSkills();
  const { data: roles = [] } = useRoleTemplates();
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [isNew, setIsNew] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | "restore" | "restore-all" | "delete">(null);
  const skill = skills.find((s) => s.name === sel) ?? (isNew ? undefined : skills[0]);
  React.useEffect(() => { if (skill && !isNew) setDraft(draftOf(skill)); }, [skill?.name, skill?.body, skill?.description, skill?.source]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = isNew || !!(skill && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(skill)));
  const refresh = () => qc.invalidateQueries({ queryKey: ["skills"] });
  const save = useMutation({
    mutationFn: () => isNew ? unwrap(api.POST("/api/v1/skills", { body: draft! })) : unwrap(api.PUT("/api/v1/skills/{name}", { params: { path: { name: skill!.name } }, body: draft! })),
    onSuccess: (s) => { void refresh(); setIsNew(false); setSel(s.name); toast.success(`Saved “${s.name}”`); },
    onError: (e: Error) => toast.error("Could not save the skill", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: (name: string) => unwrap(api.DELETE("/api/v1/skills/{name}", { params: { path: { name } } })),
    onSuccess: () => { void refresh(); toast.success(skill?.source === "custom" ? "Skill deleted" : "Default restored"); if (skill?.source === "custom") setSel(null); },
  });
  const restoreAll = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/skills/restore-defaults")),
    onSuccess: () => { void refresh(); toast.success("Built-in skills restored", { description: "Your own skills were kept." }); },
  });
  const needle = q.trim().toLowerCase();
  const shown = skills.filter((s) => !needle || `${s.name} ${s.description}`.toLowerCase().includes(needle));
  const roleName = (k: string) => roles.find((r) => r.key === k)?.role ?? k;
  const edited = skills.filter((s) => s.source === "modified").length;

  return (
    <section className="space-y-3" data-testid="skills-section">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Skills</h2>
          <p className="text-sm text-muted-foreground">Step-by-step playbooks for a kind of work. Agents see each skill's name and description and load the full steps when they need them. Projects can add their own in <code>.octopus/skills</code>, <code>.agents/skills</code> or <code>.claude/skills</code>.</p>
        </div>
        <Button size="sm" variant="outline" data-testid="new-skill" onClick={() => {
          setIsNew(true); setSel(null);
          setDraft({ name: "my-skill", description: "When to use it and what it achieves", body: "# My skill\n\n## Steps\n1. \n\n## Done when\n", roles: [], phases: [] });
        }}><Plus />New skill</Button>
        <Button size="sm" variant="ghost" disabled={!edited} onClick={() => setConfirm("restore-all")}><RotateCcw />Restore all defaults</Button>
      </div>

      <div className="flex h-[min(680px,calc(100dvh-14rem))] min-h-[440px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex w-60 shrink-0 flex-col border-r border-border">
          <label className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-xs">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" className="w-full bg-transparent outline-none" />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Skills">
            {isLoading && <div className="space-y-1 p-1">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-9" />)}</div>}
            {shown.map((s) => (
              <button key={s.name} role="option" aria-selected={!isNew && s.name === skill?.name} onClick={() => { setIsNew(false); setSel(s.name); }}
                className={cn("block w-full rounded px-2 py-1.5 text-left hover:bg-accent/60", !isNew && s.name === skill?.name && "bg-accent")}>
                <span className="flex items-center gap-1.5 text-[13px]"><span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                  {s.source !== "builtin" && <span className={cn("text-[9px] font-semibold uppercase", s.source === "modified" ? "text-warning" : "text-primary")}>{s.source === "modified" ? "edited" : "yours"}</span>}</span>
                <span className="line-clamp-1 text-[11px] text-muted-foreground">{s.description}</span>
              </button>
            ))}
          </div>
        </div>

        {draft ? (
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex items-center gap-2">
              <BookOpenCheck className="h-4 w-4 text-muted-foreground" />
              {isNew ? <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: slug(e.target.value) })} className="h-8 font-mono" aria-label="Skill name" />
                : <span className="min-w-0 flex-1 truncate font-mono text-sm">{draft.name}</span>}
              <Badge variant={isNew ? "default" : skill?.source === "builtin" ? "outline" : skill?.source === "modified" ? "warning" : "default"}>
                {isNew ? "New" : skill?.source === "builtin" ? "Built-in" : skill?.source === "modified" ? "Built-in · edited" : "Your skill"}
              </Badge>
            </div>
            <Field label="Description" hint="Agents choose skills by this line: say when to use it and what it achieves.">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Skill description" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="For roles" hint="Agents with these roles get it in their own list.">
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-1">
                    {draft.roles.map((r) => (
                      <button key={r} onClick={() => setDraft({ ...draft, roles: draft.roles.filter((x) => x !== r) })} title="Remove"
                        className="rounded-full border border-border bg-muted/40 px-2 py-px text-[11px] hover:border-destructive/50">{roleName(r)} ×</button>
                    ))}
                  </div>
                  <Combobox value="" placeholder="Add a role" ariaLabel="Add a role" options={roleOptions(roles).filter((o) => !draft.roles.includes(o.value))}
                    onChange={(v) => setDraft({ ...draft, roles: [...draft.roles, v] })} />
                </div>
              </Field>
              <Field label="Phases" hint="Loaded automatically when the phase starts (workflow).">
                <div className="flex flex-wrap gap-1">
                  {PHASES.map((p) => {
                    const on = draft.phases.includes(p);
                    return <button key={p} role="switch" aria-checked={on} onClick={() => setDraft({ ...draft, phases: on ? draft.phases.filter((x) => x !== p) : [...draft.phases, p] })}
                      className={cn("rounded-full border px-2 py-px text-[11px]", on ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent/50")}>{p}</button>;
                  })}
                </div>
              </Field>
            </div>
            <Field label="Steps (Markdown)">
              <Textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="min-h-[300px] font-mono text-[12px] leading-relaxed" aria-label="Skill steps" />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!dirty || draft.name.length < 2 || !draft.description.trim() || !draft.body.trim()} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-skill"><Save />Save</Button>
              {dirty && !isNew && skill && <Button size="sm" variant="ghost" onClick={() => setDraft(draftOf(skill))}>Discard changes</Button>}
              {isNew && <Button size="sm" variant="ghost" onClick={() => { setIsNew(false); setDraft(skill ? draftOf(skill) : null); }}>Cancel</Button>}
              <span className="flex-1" />
              {!isNew && skill?.source === "modified" && <Button size="sm" variant="outline" onClick={() => setConfirm("restore")}><RotateCcw />Restore default</Button>}
              {!isNew && skill?.source === "custom" && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm("delete")}><Trash2 />Delete</Button>}
            </div>
          </div>
        ) : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a skill</div>}
      </div>

      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} destructive={confirm === "delete"}
        title={confirm === "restore" ? `Restore “${skill?.name}” to its default?` : confirm === "restore-all" ? "Restore every built-in skill to its default?" : `Delete “${skill?.name}”?`}
        description={confirm === "restore-all" ? `${edited} edited skill(s) go back to their defaults. Your own skills are kept.` : confirm === "restore" ? "Your edits to this skill are discarded." : "Agents won't see this skill any more."}
        confirmLabel={confirm === "delete" ? "Delete" : "Restore"}
        onConfirm={() => { if (confirm === "restore-all") restoreAll.mutate(); else if (skill) remove.mutate(skill.name); }} />
    </section>
  );
}
