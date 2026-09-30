import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useSettings, useWorkspaceId } from "@/hooks/queries";
import { Select, Tip } from "@/components/ui/overlays";

/**
 * Model picker. Octopus uses one real provider, Azure OpenAI, with the deployments configured in Settings
 * (gpt-6-luna by default), plus the offline Demo model. Agents saved with other providers or models are shown (and run)
 * as the first Azure deployment, matching what the backend does.
 */
export function ModelPicker({ provider, model, onChange, compact }: { provider: string; model: string; onChange: (p: string, m: string) => void; compact?: boolean }) {
  const { data } = useSettings();
  const w = useWorkspaceId();
  const providers = data?.providers ?? [];
  const effProvider = provider === "mock" ? "mock" : "azure";
  const info = providers.find((p) => p.provider === effProvider);
  const models = info?.models ?? [];
  const effModel = models.includes(model) ? model : (models[0] ?? model);
  return (
    <div className={compact ? "grid grid-cols-2 gap-2" : "space-y-2"}>
      <Select ariaLabel="Provider" value={effProvider} onValueChange={(p) => onChange(p, providers.find((x) => x.provider === p)?.models[0] ?? "")}
        options={providers.map((p) => ({ value: p.provider, label: <span className="flex items-center gap-1.5">{p.label}{p.configured && p.provider !== "mock" ? <CheckCircle2 className="h-3 w-3 text-success" /> : null}</span>, hint: p.configured ? undefined : "not configured" }))} />
      <div className="relative">
        <Select ariaLabel="Model" value={effModel} onValueChange={(m) => onChange(effProvider, m)} className="font-mono text-xs"
          options={models.map((m) => ({ value: m, label: m }))} />
        {effProvider === "azure" && info && !info.configured && (
          <Tip content={<span>Azure OpenAI isn't connected yet, so this agent uses Demo Mode. <Link className="underline" to={`/w/${w}/settings#providers`}>Connect</Link></span>}>
            <AlertCircle className="absolute right-8 top-2.5 h-4 w-4 text-warning" />
          </Tip>
        )}
      </div>
    </div>
  );
}

/** The model an agent really runs on (same rule as the backend): Demo, or a configured Azure deployment. */
export function useEffectiveModel(provider: string | undefined, model: string | undefined): string {
  const { data } = useSettings();
  if (provider === "mock") return model || "mock/demo";
  const models = data?.providers.find((p) => p.provider === "azure")?.models ?? [];
  return model && models.includes(model) ? model : (models[0] ?? model ?? "");
}
