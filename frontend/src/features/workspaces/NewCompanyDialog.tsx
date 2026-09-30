import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Check, LayoutTemplate, Swords, Users } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { qk, useTemplates, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/overlays";

const ICONS: Record<string, typeof Building2> = { software_startup: Building2, small_dev_team: Users, debate_panel: Swords, blank: LayoutTemplate };

export function NewCompanyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (id: string) => void }) {
  const w = useWorkspaceId();
  const { data: templates } = useTemplates();
  const [key, setKey] = React.useState("software_startup");
  const [name, setName] = React.useState("");
  const qc = useQueryClient();
  const setCompany = useApp((s) => s.setCompany);
  const tpl = templates?.find((t) => t.key === key);
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/w/{workspace_id}/companies/from-template", {
      params: { path: { workspace_id: w } }, body: { template_key: key, name: name.trim() || undefined },
    })),
    onSuccess: (c) => {
      qc.setQueryData(qk.canvas(w, c.company.id), c);
      qc.invalidateQueries({ queryKey: qk.companies(w) });
      setCompany(w, c.company.id);
      toast.success(`${c.company.name} is ready`, { description: `${c.agents.length} agents, ${c.edges.length} channels` });
      onOpenChange(false);
      setName("");
      onCreated?.(c.company.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New company</DialogTitle>
          <DialogDescription>Start from a template; every agent and connection stays fully editable.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {templates?.map((t) => {
            const I = ICONS[t.key] ?? LayoutTemplate;
            const active = t.key === key;
            return (
              <button key={t.key} role="radio" aria-checked={active} onClick={() => setKey(t.key)} onDoubleClick={() => create.mutate()}
                className={cn("relative rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md",
                  active ? "border-primary bg-primary/5 shadow-md shadow-primary/10" : "border-border")}>
                {active && <Check className="absolute right-2.5 top-2.5 h-4 w-4 text-primary animate-in zoom-in-50" />}
                <I className="mb-2 h-5 w-5 text-primary" />
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{t.description}</div>
                <div className="mt-2 text-[11px] text-muted-foreground">{t.agent_count} agents · {t.edge_count} channels</div>
              </button>
            );
          })}
        </div>
        <Field label="Company name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={tpl?.name ?? "My company"} onKeyDown={(e) => e.key === "Enter" && create.mutate()} /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={create.isPending} onClick={() => create.mutate()} data-testid="create-company">Create company</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
