import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, unwrap } from "@/lib/api";
import { qk } from "@/hooks/queries";
import { serialize, useCanvas } from "@/stores/canvas";
import type { CanvasOut } from "@/types";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

/**
 * Debounced canvas autosave with optimistic concurrency. Every save carries the canvas revision it was based on;
 * if agents changed the team meanwhile (hires / edits during a run) the server answers 409 and we reload the
 * server's version instead of overwriting it. Flushes on unmount / tab close and exposes save state for the UI.
 */
export function useAutosave(workspaceId: string, companyId: string, delay = 700) {
  const version = useCanvas((s) => s.version);
  const [state, setState] = React.useState<SaveState>("saved");
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const qc = useQueryClient();
  const inflight = React.useRef<Promise<void> | null>(null);
  const pending = React.useRef(false);

  const reloadFromServer = React.useCallback(async (why: string) => {
    const fresh = await unwrap(api.GET("/api/v1/w/{workspace_id}/companies/{company_id}", { params: { path: { workspace_id: workspaceId, company_id: companyId } } }));
    qc.setQueryData(qk.canvas(workspaceId, companyId), fresh);
    useCanvas.getState().load(fresh as CanvasOut);
    toast.info("Team updated", { description: why });
    setState("saved");
  }, [workspaceId, companyId, qc]);

  const save = React.useCallback(async () => {
    const s = useCanvas.getState();
    if (!companyId || s.companyId !== companyId || s.version === s.savedVersion) return;
    if (inflight.current) { pending.current = true; return; }
    const v = s.version;
    setState("saving");
    const used = new Set(s.nodes.map((n) => n.data.department).filter(Boolean) as string[]);
    const departments = Object.fromEntries(Object.entries(s.departments).filter(([k]) => used.has(k)).map(([k, m]) => [k, { color: m.color, description: m.description ?? "" }]));
    const p = unwrap(api.PUT("/api/v1/w/{workspace_id}/companies/{company_id}/canvas", {
      params: { path: { workspace_id: workspaceId, company_id: companyId } },
      body: { ...serialize(s.nodes, s.edges), departments, revision: s.revision },
    })).then((res) => {
      useCanvas.getState().markSaved(v, res.revision);
      qc.setQueryData(qk.canvas(workspaceId, companyId), res);
      qc.invalidateQueries({ queryKey: qk.companies(workspaceId) });
      setError(null);
      setSavedAt(new Date());
      setState(useCanvas.getState().version === v ? "saved" : "dirty");
    }).catch(async (e: Error) => {
      if (e instanceof ApiError && e.status === 409) {
        setState("conflict");
        await reloadFromServer("Agents changed this company during a run (hires or config edits). Loaded the latest version.");
        return;
      }
      setError(e.message);
      setState("error");
    }).finally(() => {
      inflight.current = null;
      if (pending.current) { pending.current = false; void save(); }
    });
    inflight.current = p;
    await p;
  }, [workspaceId, companyId, qc, reloadFromServer]);

  React.useEffect(() => {
    const s = useCanvas.getState();
    if (version === 0 || version === s.savedVersion) return;
    setState("dirty");
    const t = setTimeout(() => void save(), delay);
    return () => clearTimeout(t);
  }, [version, delay, save]);

  React.useEffect(() => {
    const unsaved = () => { const s = useCanvas.getState(); return s.version !== 0 && s.version !== s.savedVersion; };
    const flush = (e: BeforeUnloadEvent) => { if (unsaved()) { void save(); e.preventDefault(); } };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); if (unsaved()) void save(); };
  }, [save]);

  return { state, error, savedAt, saveNow: save };
}
