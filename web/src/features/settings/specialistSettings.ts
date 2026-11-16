import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SettingsOut, SpecialistName, SpecialistsSettings } from "@octopus/shared";
import { qk, useSettings } from "@/hooks/queries";
import { api, unwrap } from "@/lib/api";

/** What each specialist does, in the words Settings and the canvas both show. */
export const SPECIALIST_INFO: Record<SpecialistName, { label: string; hint: string }> = {
  reviewer: { label: "Reviewer", hint: "Checks each change for correctness." },
  security: { label: "Security reviewer", hint: "Checks input, secrets, files and access in sensitive code." },
  designer: { label: "Designer", hint: "Checks how the interface looks in the browser." },
  explorer: { label: "Explorer", hint: "Answers one question about the code or the web." },
  verifier: { label: "Verifier", hint: "Checks each ask in your messages by running the product." },
};

/** The specialists in the order Settings and the canvas list them. */
export const SPECIALIST_ORDER: SpecialistName[] = ["reviewer", "security", "designer", "verifier", "explorer"];

/** The specialist settings the server holds, or undefined while they load. */
export const useSpecialists = (): SpecialistsSettings | undefined => useSettings().data?.specialists;

/** The model names the Azure connection offers. */
export function useDeployments(): string[] {
  return useSettings().data?.providers.find((p) => p.provider === "azure")?.models ?? [];
}

/** Saves the whole specialist settings in one request, and puts the server's copy into the settings cache. */
export function useSpecialistSave() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SpecialistsSettings) => unwrap(api.PUT("/api/v1/settings/specialists", { body })),
    onSuccess: (saved) => {
      queryClient.setQueryData<SettingsOut>(qk.settings, (old) => (old ? { ...old, specialists: saved } : old));
    },
  });
}
