import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SpecialistName, SpecialistsSettings } from "@octopus/shared";
import { qk } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";
import { useSpecialistSave, withSpecialist } from "@/features/settings/specialistSettings";

/** Seats a specialist on this company's canvas. The server adds the agent once and returns the company, so a repeat is harmless. */
export function useSeatSpecialist(workspaceId: string, companyId: string) {
  const queryClient = useQueryClient();
  return async (name: SpecialistName) => {
    const canvas = await unwrap(api.POST("/api/v1/w/{workspace_id}/companies/{company_id}/specialists/{name}", {
      params: { path: { workspace_id: workspaceId, company_id: companyId, name } },
    }));
    queryClient.setQueryData(qk.canvas(workspaceId, companyId), canvas);
  };
}

/**
 * Turns one specialist on or off for every conversation, the same change Settings makes. Turning one on also seats it on
 * this company's canvas, so its card appears at once.
 */
export function useSpecialistToggle(workspaceId: string, companyId: string) {
  const save = useSpecialistSave();
  const seat = useSeatSpecialist(workspaceId, companyId);
  return async (current: SpecialistsSettings, name: SpecialistName, enabled: boolean) => {
    try {
      await save.mutateAsync(withSpecialist(current, name, { enabled }));
      if (enabled) await seat(name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the specialist");
    }
  };
}
