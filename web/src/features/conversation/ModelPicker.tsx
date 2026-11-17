import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Cloud,
  Settings2,
  RotateCcw,
  Zap,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/overlays";
import { EFFORTS } from "@/features/canvas/EffortPicker";
import type { ModelSettings } from "./workbenchStore";
import "./model-picker.css";

export function ModelPicker({
  value,
  onChange,
  workspace,
  locked = false,
  compact = false,
}: {
  value: ModelSettings;
  onChange: (value: ModelSettings) => void;
  workspace?: string;
  locked?: boolean;
  compact?: boolean;
}) {
  const settings = useSettings();
  const azure = settings.data?.providers.find(
    (provider) => provider.provider === "azure",
  );
  const label = value.model ?? "Team default";
  const effortLabel =
    EFFORTS.find((effort) => effort.value === value.reasoning_effort)?.label ??
    "Auto";
  const settingsPath = workspace
    ? `/w/${workspace}/settings#providers`
    : "/settings#providers";
  const effortIndex = Math.max(
    0,
    EFFORTS.findIndex((effort) => effort.value === value.reasoning_effort),
  );
  const rangeStyle: CSSProperties & { "--thinking-progress": string } = {
    "--thinking-progress": `${(effortIndex / (EFFORTS.length - 1)) * 100}%`,
  };
  const modelPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className="w-full justify-center"
          data-tooltip-managed
          aria-label={`Select model: ${label}`}
        >
          <span className={compact ? "max-w-56 truncate" : "max-w-36 truncate"}>
            {label}
          </span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="top"
        className="w-72 max-h-[min(70vh,36rem)] overflow-y-auto"
      >
        <DropdownMenuLabel>Conversation model</DropdownMenuLabel>
        {locked && (
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            This conversation keeps its recorded model. Start a new conversation
            to change it.
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Azure OpenAI</DropdownMenuLabel>
        {azure?.models.map((model) => (
          <DropdownMenuItem
            key={model}
            disabled={locked || !azure.configured}
            onSelect={() => onChange({ ...value, model })}
          >
            <Cloud />
            <span className="min-w-0 flex-1 truncate">{model}</span>
            {value.model === model && <Check />}
          </DropdownMenuItem>
        ))}
        {!azure?.configured && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Connect Azure in Model settings to use your deployments.
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
  );
  return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size={compact ? "icon" : "xs"}
            variant="ghost"
            className={compact ? "composer-model composer-model--compact" : "composer-model"}
            data-tooltip-managed
            aria-label={`Select model and thinking level: ${label}, ${effortLabel}`}
            title={`Model: ${label} · Thinking: ${effortLabel}`}
          >
            {compact ? (
              <Brain />
            ) : (
              <>
                <span className="max-w-36 truncate">{label}</span>
                <span className="text-primary">{effortLabel}</span>
                <ChevronDown />
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="thinking-popover">
          <div className="thinking-popover-heading">
            <Zap aria-hidden className="thinking-popover-speed" />
            <p className="thinking-popover-level">{effortLabel}</p>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="thinking-popover-reset"
              aria-label="Reset thinking level to Auto"
              disabled={locked}
              onClick={() =>
                onChange({ ...value, reasoning_effort: "default" })
              }
            >
              <RotateCcw />
            </Button>
          </div>
          {modelPicker}
          <div
            className="thinking-range"
            style={rangeStyle}
            title={
              locked
                ? "Start a new conversation to change its model and thinking level"
                : undefined
            }
          >
            <div className="thinking-range-track" aria-hidden>
              <div className="thinking-range-stops">
                {EFFORTS.map((effort) => (
                  <span key={effort.value} />
                ))}
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={EFFORTS.length - 1}
              step={1}
              aria-label="Thinking level"
              aria-valuetext={effortLabel}
              value={effortIndex}
              disabled={locked}
              onChange={(event) => {
                const effort = EFFORTS[Number(event.target.value)];
                if (effort)
                  onChange({ ...value, reasoning_effort: effort.value });
              }}
            />
          </div>
          {locked && (
            <p className="sr-only">
              This conversation keeps its model and thinking level. Start a new
              conversation to change them.
            </p>
          )}
        </PopoverContent>
      </Popover>
    );
}
