import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ResilientSocket, type SocketState } from "@/lib/socket";
import { wsUrl } from "@/lib/api";
import { qk } from "@/hooks/queries";
import type { RunEvent } from "@/types";
import { initialRun, reduceRun, type RunLive } from "./runState";

/**
 * Subscribes to a run's WebSocket. On (re)connect the server replays every persisted event after the
 * last seen seq, so state stays consistent across network blips. Keeps the persisted event log for replay.
 */
export function useRunStream(workspaceId: string, runId: string | undefined, names: Record<string, string>) {
  const namesRef = React.useRef(names);
  namesRef.current = names;
  const [state, dispatch] = React.useReducer((s: RunLive, e: RunEvent) => reduceRun(s, e, namesRef.current), undefined, initialRun);
  const [conn, setConn] = React.useState<SocketState>("connecting");
  const events = React.useRef<RunEvent[]>([]);
  const [eventCount, setEventCount] = React.useState(0);
  const sock = React.useRef<ResilientSocket<RunEvent> | null>(null);
  const qc = useQueryClient();
  const toasted = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (!workspaceId || !runId) return;
    events.current = [];
    let batch: RunEvent[] = [];
    let raf = 0;
    const flush = () => { raf = 0; const b = batch; batch = []; for (const e of b) dispatch(e); setEventCount(events.current.length); };
    const s = new ResilientSocket<RunEvent>({
      url: (last) => wsUrl(`/ws/w/${workspaceId}/runs/${runId}`, { last_seq: last }),
      seqOf: (e) => e.seq,
      onState: setConn,
      onEvent: (e) => {
        if (e.seq) events.current.push(e);
        batch.push(e);
        if (!raf) raf = requestAnimationFrame(flush);
        if (e.replay) return;
        if (e.type === "run_status" && e.data.final) {
          qc.invalidateQueries({ queryKey: qk.run(workspaceId, runId) });
          qc.invalidateQueries({ queryKey: qk.runs(workspaceId) });
          qc.invalidateQueries({ queryKey: qk.artifacts(workspaceId, runId) });
          qc.invalidateQueries({ queryKey: qk.files(workspaceId) });
          const st = e.data.status as string;
          if (!toasted.current.has(st)) {
            toasted.current.add(st);
            if (st === "completed") toast.success("Run completed", { description: e.data.summary?.slice(0, 160) });
            else if (st === "failed") toast.error("Run halted", { description: e.data.reason });
            else toast("Run stopped");
          }
        }
        if (e.type === "approval_requested") toast.warning("Approval needed", { description: e.data.summary, duration: 6000 });
        if (e.type === "error" && e.data.kind === "loop") toast.error("Loop detected", { description: e.data.message });
        if (e.type === "artifact_updated") qc.invalidateQueries({ queryKey: qk.artifacts(workspaceId, runId) });
        if ((e.type === "agent_created" || e.type === "agent_updated") && e.data.persisted) {
          qc.invalidateQueries({ queryKey: ["canvas", workspaceId] });
          qc.invalidateQueries({ queryKey: qk.companies(workspaceId) });
        }
        if (e.type === "agent_created") {
          const a = e.data.agent as { name: string; role: string; department?: string };
          toast(`${namesRef.current[e.data.created_by] ?? "An agent"} hired ${a.name}`, { description: `${a.role}${a.department ? ` · ${a.department}` : ""}`, duration: 2500 });
          namesRef.current = { ...namesRef.current, [(e.data.agent as { id: string }).id]: a.name };
        }
      },
    });
    sock.current = s;
    return () => { s.close(); if (raf) cancelAnimationFrame(raf); sock.current = null; };
  }, [workspaceId, runId, qc]);

  const send = React.useCallback((msg: Record<string, unknown>) => sock.current?.send(msg), []);
  return { state, conn, send, events: events.current, eventCount };
}
