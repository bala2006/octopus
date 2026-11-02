import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import type { ApprovalMode } from "./workbenchStore";

export function ApprovalModePicker({
  value,
  onChange,
  disabled = false,
  label,
  compact = false,
}: {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void;
  disabled?: boolean;
  label?: string;
  compact?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size={compact ? "icon" : "xs"}
          variant="ghost"
          className={
            compact
              ? "composer-approval composer-approval--compact"
              : "composer-approval"
          }
          aria-label={`Action approval: ${label ?? (value === "auto" ? "Approve for me" : "Ask for approval")}`}
          title={
            label ?? (value === "auto" ? "Approve for me" : "Ask for approval")
          }
          disabled={disabled && !compact}
        >
          <ShieldCheck />
          {!compact && (
            <>
              <span>
                {label ??
                  (value === "auto" ? "Approve for me" : "Ask for approval")}
              </span>
              <ChevronDown />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <DropdownMenuLabel>
          How should Octopus handle actions?
        </DropdownMenuLabel>
        {disabled && (
          <p className="px-3 pb-2 text-xs text-muted-foreground">
            {label ??
              "This conversation keeps its recorded permissions. Start a new conversation to change them."}
          </p>
        )}
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => onChange("ask")}
          className="h-auto items-start py-2.5"
        >
          <ShieldCheck className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <strong className="block font-medium">Ask for approval</strong>
            <small className="mt-0.5 block whitespace-normal text-[11px] leading-relaxed text-muted-foreground">
              Ask before project edits, commands, external tools, and web
              searches.
            </small>
          </span>
          {value === "ask" && <Check className="mt-1" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => onChange("auto")}
          className="h-auto items-start py-2.5"
        >
          <ShieldCheck className="mt-0.5" />
          <span className="min-w-0 flex-1">
            <strong className="block font-medium">Approve for me</strong>
            <small className="mt-0.5 block whitespace-normal text-[11px] leading-relaxed text-muted-foreground">
              Auto-approve project edits and sandboxed commands. Octopus still
              asks before external tools.
            </small>
          </span>
          {value === "auto" && <Check className="mt-1" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <p className="px-3 pb-2 text-[10px] leading-relaxed text-muted-foreground">
          Project permission settings can further restrict what agents may do.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
