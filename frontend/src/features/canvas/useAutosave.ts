import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { qk } from "@/hooks/queries";
import { serialize, useCanvas } from "@/stores/canvas";

export type SaveState = "saved" | "dirty" | "saving" | "error";

/** Debounced canvas autosave. Flushes on unmount / tab close and exposes save state for UI feedback. */
export function useAutosave(workspaceId: string, companyId: string, delay = 700) {
  const version = useCanvas((s) => s.version);
  const [state, setState] = React.useState<SaveState>("saved");
  const [error, setError] = React.useState<string | null>(null);
  const [savedAt, setSavedAt] = React.useState<Date | null>(null);
  const qc = useQueryClient();
  const inflight = React.useRef<Promise<void> | null>(null);
  const pending = React.useRef(false);
  const lastSaved = React.useRef(0);

  const save = React.useCallback(async () => {
    const s = useCanvas.getState();
    if (!companyId || s.companyId !== companyId) return;
    if (inflight.current) { pending.current = true; return; }
    const v = s.version;
    setState("saving");
    const body = serialize(s.nodes, s.edges);
    const p = unwrap(api.PUT("/api/v1/w/{workspace_id}/companies/{company_id}/canvas", {
      params: { path: { workspace_id: workspaceId, company_id: companyId } }, body,
    })).then((res) => {
      lastSaved.current = v;
      qc.setQueryData(qk.canvas(workspaceId, companyId), res);
      qc.invalidateQueries({ queryKey: qk.companies(workspaceId) });
      setError(null);
      setSavedAt(new Date());
      setState(useCanvas.getState().version === v ? "saved" : "dirty");
    }).catch((e: Error) => { setError(e.message); setState("error"); })
      .finally(() => {
        inflight.current = null;
        if (pending.current) { pending.current = false; void save(); }
      });
    inflight.current = p;
    await p;
  }, [workspaceId, companyId, qc]);

  React.useEffect(() => {
    if (version === 0 || version === lastSaved.current) return;
    setState("dirty");
    const t = setTimeout(() => void save(), delay);
    return () => clearTimeout(t);
  }, [version, delay, save]);

  React.useEffect(() => {
    const flush = (e: BeforeUnloadEvent) => {
      if (useCanvas.getState().version !== lastSaved.current && useCanvas.getState().version !== 0) { void save(); e.preventDefault(); }
    };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); if (useCanvas.getState().version !== lastSaved.current && useCanvas.getState().version !== 0) void save(); };
  }, [save]);

  return { state, error, savedAt, saveNow: save };
}
