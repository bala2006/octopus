import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import { api, unwrap } from "@/lib/api";
import { qk, useSettings } from "@/hooks/queries";
import { APPROVAL_MODES, approvalModeOf } from "@/lib/meta";
import type { ApprovalMode, SettingsOut } from "@/types";

/**
 * The one approval setting for every project. It is stored on the server and read by each run when it starts,
 * so a change applies to the next run and never to a run that is already going.
 */
export function ApprovalModePicker({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useSettings();
  const value = approvalModeOf(data?.approval_mode);
  const save = useMutation({
    mutationFn: (mode: ApprovalMode) =>
      unwrap(
        api.PUT("/api/v1/settings/approval-mode", {
          body: { approval_mode: mode },
        }),
      ),
    onMutate: async (mode) => {
      await queryClient.cancelQueries({ queryKey: qk.settings });
      const previous = queryClient.getQueryData<SettingsOut>(qk.settings);
      if (previous)
        queryClient.setQueryData<SettingsOut>(qk.settings, {
          ...previous,
          approval_mode: mode,
        });
      return { previous };
    },
    onError: (error, _mode, context) => {
      if (context?.previous)
        queryClient.setQueryData(qk.settings, context.previous);
      toast.error("Could not change approval mode", {
        description: error.message,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.settings }),
  });
  const current = APPROVAL_MODES[value];
  const choose = (mode: ApprovalMode) => {
    if (mode !== value) save.mutate(mode);
  };

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
          aria-label={`Approval mode: ${current.label}`}
          title={current.label}
        >
          <ShieldCheck />
          {!compact && (
            <>
              <span>{current.label}</span>
              <ChevronDown />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <DropdownMenuLabel>
          How should Octopus handle actions?
        </DropdownMenuLabel>
        {(Object.keys(APPROVAL_MODES) as ApprovalMode[]).map((mode) => (
          <DropdownMenuItem
            key={mode}
            onSelect={() => choose(mode)}
            className="h-auto items-start py-2.5"
          >
            <ShieldCheck className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <strong className="block font-medium">
                {APPROVAL_MODES[mode].label}
              </strong>
              <small className="mt-0.5 block whitespace-normal text-[11px] leading-relaxed text-muted-foreground">
                {APPROVAL_MODES[mode].description}
              </small>
            </span>
            {value === mode && <Check className="mt-1" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-3 pb-2 text-[10px] leading-relaxed text-muted-foreground">
          The new setting applies to the next run you start.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
