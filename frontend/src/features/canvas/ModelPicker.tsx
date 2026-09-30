import * as React from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useSettings, useWorkspaceId } from "@/hooks/queries";
import { Input } from "@/components/ui/primitives";
import { Select, Tip } from "@/components/ui/overlays";

/** Provider + model (Azure deployment / Foundry model) picker. Model is free text with suggestions. */
export function ModelPicker({ provider, model, onChange, compact }: { provider: string; model: string; onChange: (p: string, m: string) => void; compact?: boolean }) {
  const { data } = useSettings();
  const w = useWorkspaceId();
  const providers = data?.providers ?? [];
  const info = providers.find((p) => p.provider === provider);
  const listId = React.useId();
  return (
    <div className={compact ? "grid grid-cols-2 gap-2" : "space-y-2"}>
      <Select ariaLabel="Provider" value={provider} onValueChange={(p) => onChange(p, providers.find((x) => x.provider === p)?.models[0] ?? "")}
        options={providers.map((p) => ({ value: p.provider, label: <span className="flex items-center gap-1.5">{p.label}{p.configured ? <CheckCircle2 className="h-3 w-3 text-success" /> : null}</span>, hint: p.configured ? undefined : "not configured" }))} />
      <div className="relative">
        <Input list={listId} value={model} onChange={(e) => onChange(provider, e.target.value)} placeholder={provider === "azure" ? "deployment name" : "model"} aria-label="Model" className="pr-7 font-mono text-xs" />
        <datalist id={listId}>{info?.models.map((m) => <option key={m} value={m} />)}</datalist>
        {info && !info.configured && (
          <Tip content={<span>Not configured, so this agent uses Demo Mode. <Link className="underline" to={`/w/${w}/settings`}>Configure</Link></span>}>
            <AlertCircle className="absolute right-2 top-2.5 h-4 w-4 text-warning" />
          </Tip>
        )}
      </div>
    </div>
  );
}
