import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookmarkPlus } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { useWorkspaceId } from "@/hooks/queries";
import { useCanvas } from "@/stores/canvas";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/overlays";

/** Save the current company (departments, agents, prompts, tools, channels) as a reusable template. */
export function SaveTemplateDialog({ open, onOpenChange, companyId, defaultName, flush }: {
  open: boolean; onOpenChange: (o: boolean) => void; companyId: string; defaultName: string; flush: () => Promise<void>;
}) {
  const w = useWorkspaceId();
  const [name, setName] = React.useState(defaultName);
  const [description, setDescription] = React.useState("");
  const nodes = useCanvas((s) => s.nodes);
  const depts = new Set(nodes.map((n) => n.data.department).filter(Boolean));
  const qc = useQueryClient();
  React.useEffect(() => { if (open) setName(`${defaultName} template`); }, [open, defaultName]);
  const save = useMutation({
    mutationFn: async () => {
      await flush();
      return unwrap(api.POST("/api/v1/w/{workspace_id}/companies/{company_id}/save-template", {
        params: { path: { workspace_id: w, company_id: companyId } }, body: { name: name.trim(), description },
      }));
    },
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      toast.success(`Saved "${t.name}"`, { description: `${t.agent_count} agents in ${(t.departments ?? []).length} departments. Available in New company in every project.` });
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BookmarkPlus className="h-4 w-4 text-primary" />Save as template</DialogTitle>
          <DialogDescription>{nodes.length} agents · {depts.size} departments. Prompts, tools, org chart and channels are included; run history is not.</DialogDescription>
        </DialogHeader>
        <Field label="Template name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && save.mutate()} /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What kind of work is this company good at?" /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim()} loading={save.isPending} data-testid="save-template"><BookmarkPlus />Save template</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
