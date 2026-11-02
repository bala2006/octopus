import { Link } from "react-router-dom";
import type { CSSProperties } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Cloud,
  Settings2,
  Sparkles,
  Terminal,
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
  const opencode = settings.data?.providers.find(
    (provider) => provider.provider === "opencode",
  );
  const label =
    value.model?.provider === "mock"
      ? "Offline demo"
      : value.model?.provider === "opencode"
        ? value.model.model === "default"
          ? "OpenCode default"
          : value.model.model
        : (value.model?.model ??
          (settings.data?.default_provider === "opencode"
            ? "OpenCode default"
            : "Team default"));
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
  const thinkingLocked = locked || value.model?.provider === "mock";
  const modelPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          className={compact ? "w-full justify-center" : "composer-model"}
          data-tooltip-managed={compact ? true : undefined}
          aria-label={`Select model: ${label}`}
        >
          {!compact && <Sparkles />}
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
          <span className="flex-1">
            {settings.data?.default_provider === "opencode"
              ? "OpenCode default"
              : "Team default"}
          </span>
          {!value.model && <Check />}
        </DropdownMenuItem>
        <DropdownMenuLabel>
          OpenCode · installed on this computer
        </DropdownMenuLabel>
        {opencode?.models
          .filter((model) => model !== "default")
          .map((model) => (
            <DropdownMenuItem
              key={`opencode:${model}`}
              disabled={locked || !opencode.configured}
              onSelect={() =>
                onChange({ ...value, model: { provider: "opencode", model } })
              }
            >
              <Terminal />
              <span className="min-w-0 flex-1 truncate">{model}</span>
              {value.model?.provider === "opencode" &&
                value.model.model === model && <Check />}
            </DropdownMenuItem>
          ))}
        {!opencode?.configured && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            OpenCode is unavailable. Check the installed CLI in Model settings.
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Azure OpenAI</DropdownMenuLabel>
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
        {!azure?.configured && !opencode?.configured && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Connect Azure in Model settings to use your deployments. The demo is
            scripted and free.
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
  if (compact)
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="composer-model composer-model--compact"
            data-tooltip-managed
            aria-label={`Select model and thinking level: ${label}, ${effortLabel}`}
            title={`Model: ${label} · Thinking: ${effortLabel}`}
          >
            <Brain />
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
              disabled={thinkingLocked}
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
              disabled={thinkingLocked}
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
          {value.model?.provider === "mock" && (
            <p className="sr-only">The offline demo does not use reasoning.</p>
          )}
        </PopoverContent>
      </Popover>
    );
  return (
    <>
      {modelPicker}
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
