import * as React from "react";
import { toast } from "sonner";
import type { SpecialistName, SpecialistsSettings } from "@octopus/shared";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/overlays";
import { Field, Switch } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/surfaces";
import { EFFORTS } from "@/features/canvas/EffortPicker";
import { SPECIALIST_INFO, SPECIALIST_ORDER, useDeployments, useSpecialistSave, useSpecialists } from "./specialistSettings";

const ROUNDS = [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));

/** The specialists that check Octopus's work, the review floor, and its round caps. Changes apply to conversations that start after a save. */
export function SpecialistsSection() {
  const saved = useSpecialists();
  const models = useDeployments();
  const save = useSpecialistSave();
  const [draft, setDraft] = React.useState<SpecialistsSettings | null>(null);
  if (!saved) return <p className="text-sm text-muted-foreground">Loading the specialists…</p>;
  const value = draft ?? saved;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const edit = (change: (next: SpecialistsSettings) => void) => {
    const next: SpecialistsSettings = JSON.parse(JSON.stringify(value));
    change(next);
    setDraft(next);
  };
  const setSpecialist = (name: SpecialistName, patch: Partial<SpecialistsSettings["specialists"][SpecialistName]>) =>
    edit((next) => { next.specialists[name] = { ...next.specialists[name], ...patch }; });
  const setCap = (key: "floor_rounds" | "check_blocks" | "verify_rounds", n: number) => edit((next) => { next.review[key] = n; });
  const saveDraft = () => save.mutate(value, {
    onSuccess: () => { setDraft(null); toast.success("Specialists saved"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the specialists"),
  });

  return (
    <section className="space-y-3">
      <PageHeader heading="h2" title="Specialists" description="The read-only specialists that check Octopus's work in a solo conversation. Changes apply to conversations that start after you save." />
      <ul className="space-y-2">
        {SPECIALIST_ORDER.map((name) => {
          const info = SPECIALIST_INFO[name];
          const s = value.specialists[name];
          const options = [...new Set([...models, s.model])].map((m) => ({ value: m, label: m }));
          return (
            <li key={name} className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <div className="text-sm font-medium">{info.label}</div>
                <div className="text-xs text-muted-foreground">{info.hint}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Switch checked={s.enabled} onCheckedChange={(enabled) => setSpecialist(name, { enabled })} aria-label={`Run ${info.label}`} />
                <div className="w-40">
                  <Select ariaLabel={`Model for ${info.label}`} value={s.model} onValueChange={(model) => setSpecialist(name, { model })} options={options} className="font-mono text-xs" />
                </div>
                <div className="w-32">
                  <Select ariaLabel={`Effort for ${info.label}`} value={s.effort} onValueChange={(effort) => setSpecialist(name, { effort: effort as SpecialistsSettings["specialists"][SpecialistName]["effort"] })}
                    options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="space-y-3 rounded-xl border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Review floor</div>
            <div className="text-xs text-muted-foreground">After each reply, the reviewers check a normal or large change, and the verifier checks its asks. Off skips every review round.</div>
          </div>
          <Switch checked={value.review.floor} onCheckedChange={(floor) => edit((next) => { next.review.floor = floor; })} aria-label="Review floor" />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Review rounds per request">
            <Select ariaLabel="Review rounds per request" value={String(value.review.floor_rounds)} onValueChange={(v) => setCap("floor_rounds", Number(v))} options={ROUNDS} />
          </Field>
          <Field label="Failing-check messages per request">
            <Select ariaLabel="Failing-check messages per request" value={String(value.review.check_blocks)} onValueChange={(v) => setCap("check_blocks", Number(v))} options={ROUNDS} />
          </Field>
          <Field label="Acceptance rounds per request">
            <Select ariaLabel="Acceptance rounds per request" value={String(value.review.verify_rounds)} onValueChange={(v) => setCap("verify_rounds", Number(v))} options={ROUNDS} />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={saveDraft} disabled={!dirty} loading={save.isPending}>Save specialists</Button>
      </div>
    </section>
  );
}
