import { Link } from "react-router-dom";
import {
  Brain,
  Check,
  ChevronDown,
  Cloud,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useSettings } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { EFFORTS } from "@/features/canvas/EffortPicker";
import type { ComposerSettings } from "./workbenchStore";

export function ModelPicker({
  value,
  onChange,
  workspace,
  locked = false,
}: {
  value: ComposerSettings;
  onChange: (value: ComposerSettings) => void;
  workspace?: string;
  locked?: boolean;
}) {
  const settings = useSettings();
  const azure = settings.data?.providers.find(
    (provider) => provider.provider === "azure",
  );
  const label =
    value.model?.provider === "mock" ||
    (!value.model && settings.data && !azure?.configured)
      ? "Offline demo"
      : (value.model?.model ?? "Team default");
  const effortLabel =
    EFFORTS.find((effort) => effort.value === value.reasoning_effort)?.label ??
    "Auto";
  const settingsPath = workspace
    ? `/w/${workspace}/settings#providers`
    : "/settings#providers";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            variant="ghost"
            className="composer-model"
            aria-label={`Select model: ${label}`}
          >
            <Sparkles />
            <span className="max-w-36 truncate">{label}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-72">
          <DropdownMenuLabel>Conversation model</DropdownMenuLabel>
          {locked && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              This conversation keeps its recorded model. Start a new
              conversation to change it.
            </p>
          )}
          <DropdownMenuItem
            disabled={locked || settings.isPending}
            onSelect={() => onChange({ ...value, model: null })}
          >
            <Cloud />
            <span className="flex-1">Team default</span>
            {!value.model && <Check />}
          </DropdownMenuItem>
          {azure?.models.map((model) => (
            <DropdownMenuItem
              key={model}
              disabled={locked || !azure.configured}
              onSelect={() =>
                onChange({ ...value, model: { provider: "azure", model } })
              }
            >
              <Cloud />
              <span className="min-w-0 flex-1 truncate">{model}</span>
              {value.model?.provider === "azure" &&
                value.model.model === model && <Check />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem
            disabled={locked}
            onSelect={() =>
              onChange({
                ...value,
                model: { provider: "mock", model: "mock/demo" },
              })
            }
          >
            <Sparkles />
            <span className="flex-1">Offline demo</span>
            {value.model?.provider === "mock" && <Check />}
          </DropdownMenuItem>
          {!azure?.configured && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Connect Azure in Model settings to use your deployments. The demo
              is scripted and free.
            </p>
          )}
          {settings.isError && (
            <DropdownMenuItem onSelect={() => void settings.refetch()}>
              Could not load models. Retry
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to={settingsPath}>
              <Settings2 />
              Model settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Reasoning effort: ${effortLabel}`}
          >
            <Brain />
            <span>{effortLabel}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
          {locked && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              Start a new conversation to change reasoning effort.
            </p>
          )}
          {value.model?.provider === "mock" && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              The scripted demo does not use reasoning.
            </p>
          )}
          {EFFORTS.map((effort) => (
            <DropdownMenuItem
              key={effort.value}
              disabled={locked || value.model?.provider === "mock"}
              onSelect={() =>
                onChange({ ...value, reasoning_effort: effort.value })
              }
            >
              <span className="flex-1">{effort.label}</span>
              {value.reasoning_effort === effort.value && <Check />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
