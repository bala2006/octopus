/** Settings → Roles: the role library. Edit built-in roles (and restore their defaults) or create roles of your own.
 * Agents linked to a role run with its current prompt, so an edit here applies to every agent with that role. */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Plus, RotateCcw, Save, Search, Trash2, UserCog } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRoleTemplates } from "@/hooks/queries";
import type { RoleTemplateOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Select } from "@/components/ui/overlays";

export const ROLE_CATEGORIES = ["Leadership", "Product", "Design", "Engineering", "Quality", "Operations", "Security", "Research", "Data",
  "Content", "Growth", "Support", "Debate", "General"] as const;
export const PROMPT_VARS = ["{{agent_name}}", "{{role}}", "{{company_name}}", "{{goal}}", "{{department}}", "{{manager}}", "{{reports}}", "{{team}}"];

type Draft = { role: string; category: string; description: string; system_prompt: string };
const draftOf = (r: RoleTemplateOut): Draft => ({ role: r.role, category: r.category, description: r.description, system_prompt: r.system_prompt });

/** What the API stores: the edited fields, plus the role's look so it carries over (duplicates, overrides). */
const bodyOf = (d: Draft, base?: RoleTemplateOut) => ({ ...d, default_name: base?.default_name ?? "", color: base?.color ?? "", avatar: base?.avatar ?? "" });

/** Roles grouped by category in a stable order (built-in categories first, then anything custom). */
export function groupRoles(roles: RoleTemplateOut[]): [string, RoleTemplateOut[]][] {
  const by = new Map<string, RoleTemplateOut[]>();
  for (const r of roles) by.set(r.category || "General", [...(by.get(r.category || "General") ?? []), r]);
  const order = (c: string) => { const i = (ROLE_CATEGORIES as readonly string[]).indexOf(c); return i < 0 ? 99 : i; };
  return [...by.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([c, rs]) => [c, rs.sort((a, b) => a.role.localeCompare(b.role))]);
}

export function RolesSection() {
  const { data: roles = [], isLoading } = useRoleTemplates();
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [confirm, setConfirm] = React.useState<null | "restore" | "restore-all" | "delete">(null);
  const promptRef = React.useRef<HTMLTextAreaElement>(null);
  const role = roles.find((r) => r.key === sel) ?? roles[0];
  React.useEffect(() => { if (role) setDraft(draftOf(role)); }, [role?.key, role?.system_prompt, role?.role, role?.category, role?.description]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!(role && draft && JSON.stringify(draft) !== JSON.stringify(draftOf(role)));
  const refresh = () => qc.invalidateQueries({ queryKey: ["roles"] });
  const save = useMutation({
    mutationFn: () => unwrap(api.PUT("/api/v1/roles/{key}", { params: { path: { key: role!.key } }, body: bodyOf(draft!, role) })),
    onSuccess: () => { void refresh(); toast.success(`Saved “${draft!.role}”`, { description: "Agents with this role use the new prompt from their next turn." }); },
    onError: (e: Error) => toast.error("Could not save the role", { description: e.message }),
  });
  const create = useMutation({
    mutationFn: (d: Draft) => unwrap(api.POST("/api/v1/roles", { body: bodyOf(d, role) })),
    onSuccess: (r) => { void refresh(); setSel(r.key); toast.success(`Created “${r.role}”`); },
    onError: (e: Error) => toast.error("Could not create the role", { description: e.message }),
  });
  const remove = useMutation({
    mutationFn: (key: string) => unwrap(api.DELETE("/api/v1/roles/{key}", { params: { path: { key } } })),
    onSuccess: () => { void refresh(); toast.success(role?.source === "custom" ? "Role deleted" : "Default restored"); if (role?.source === "custom") setSel(null); },
    onError: (e: Error) => toast.error(e.message),
  });
  const restoreAll = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/roles/restore-defaults")),
    onSuccess: () => { void refresh(); toast.success("All built-in roles are back to their defaults", { description: "Your own roles were kept." }); },
  });
  const insertVar = (v: string) => {
    const el = promptRef.current;
    if (!el || !draft) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setDraft({ ...draft, system_prompt: draft.system_prompt.slice(0, a) + v + draft.system_prompt.slice(b) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + v.length, a + v.length); });
  };
  const needle = q.trim().toLowerCase();
  const groups = groupRoles(roles.filter((r) => !needle || `${r.role} ${r.category} ${r.description}`.toLowerCase().includes(needle)));
  const modified = roles.filter((r) => r.source === "modified").length;

  return (
    <section className="space-y-3" data-testid="roles-section">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Roles</h2>
          <p className="text-sm text-muted-foreground">Each role carries a system prompt. Agents with a role run with its current prompt, so changes here apply to all of them, in every project.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => create.mutate({ role: "New role", category: "General", description: "", system_prompt: "You are {{agent_name}}, {{role}} at {{company_name}}.\n\n## Mission\n\n## Responsibilities\n- \n\n## When to finish\n" })} data-testid="new-role">
          <Plus />New role
        </Button>
        <Button size="sm" variant="ghost" disabled={!modified} onClick={() => setConfirm("restore-all")}><RotateCcw />Restore all defaults</Button>
      </div>

      <div className="flex min-h-[560px] overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex w-60 shrink-0 flex-col border-r border-border">
          <label className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-xs">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search roles" aria-label="Search roles" className="w-full bg-transparent outline-none" />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Roles">
            {isLoading && <div className="space-y-1 p-1">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-7" />)}</div>}
            {groups.map(([cat, rs]) => (
              <div key={cat}>
                <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{cat}</div>
                {rs.map((r) => (
                  <button key={r.key} role="option" aria-selected={r.key === role?.key} onClick={() => setSel(r.key)} data-testid="role-item"
                    className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-accent/60", r.key === role?.key && "bg-accent")}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.color }} />
                    <span className="min-w-0 flex-1 truncate">{r.role}</span>
                    {r.source !== "builtin" && <span className={cn("text-[9px] font-semibold uppercase", r.source === "modified" ? "text-warning" : "text-primary")}>{r.source === "modified" ? "edited" : "yours"}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {role && draft ? (
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
            <div className="flex items-center gap-2">
              <UserCog className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{role.key}</span>
              <Badge variant={role.source === "builtin" ? "outline" : role.source === "modified" ? "warning" : "default"}>
                {role.source === "builtin" ? "Built-in" : role.source === "modified" ? "Built-in · edited" : "Your role"}
              </Badge>
            </div>
            <div className="grid grid-cols-[1fr_170px] gap-2">
              <Field label="Title"><Input value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} aria-label="Role title" /></Field>
              <Field label="Category">
                <Select ariaLabel="Category" value={draft.category || "General"} onValueChange={(v) => setDraft({ ...draft, category: v })}
                  options={ROLE_CATEGORIES.map((c) => ({ value: c, label: c }))} />
              </Field>
            </div>
            <Field label="Description" hint="Shown when picking a role.">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Role description" />
            </Field>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <span className="mr-1 font-medium">System prompt</span>
                {PROMPT_VARS.map((v) => (
                  <button key={v} type="button" onClick={() => insertVar(v)} className="rounded border border-border px-1 py-px font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground">{v}</button>
                ))}
              </div>
              <Textarea ref={promptRef} value={draft.system_prompt} onChange={(e) => setDraft({ ...draft, system_prompt: e.target.value })}
                className="min-h-[300px] flex-1 font-mono text-[12px] leading-relaxed" aria-label="System prompt" data-testid="role-prompt" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!dirty || !draft.role.trim() || !draft.system_prompt.trim()} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-role"><Save />Save</Button>
              {dirty && <Button size="sm" variant="ghost" onClick={() => setDraft(draftOf(role))}>Discard changes</Button>}
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => create.mutate({ ...draft, role: `${draft.role} (copy)` })}><Copy />Duplicate</Button>
              {role.source === "modified" && <Button size="sm" variant="outline" onClick={() => setConfirm("restore")} data-testid="restore-role"><RotateCcw />Restore default</Button>}
              {role.source === "custom" && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirm("delete")}><Trash2 />Delete</Button>}
            </div>
          </div>
        ) : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a role</div>}
      </div>

      <ConfirmDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} destructive={confirm === "delete"}
        title={confirm === "restore" ? `Restore “${role?.role}” to its default?` : confirm === "restore-all" ? "Restore every built-in role to its default?" : `Delete “${role?.role}”?`}
        description={confirm === "restore" ? "Your edits to this role are discarded. Agents with this role use the default prompt again."
          : confirm === "restore-all" ? `${modified} edited role(s) go back to their defaults. Roles you created are kept.`
          : "Agents that use this role keep their current prompt as their own."}
        confirmLabel={confirm === "delete" ? "Delete" : "Restore"}
        onConfirm={() => { if (confirm === "restore-all") restoreAll.mutate(); else if (role) remove.mutate(role.key); }} />
    </section>
  );
}
