import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { wsUrl } from "@/lib/api";
import { ResilientSocket, type SocketState } from "@/lib/socket";
import { qk } from "@/hooks/queries";
import type { MessageOut, ParsedFileOut } from "@/types";

export interface StreamingMsg { id: string; text: string; phase: "thinking" | "writing" | "tool"; detail: string; tools: Array<{ name: string; args: unknown; result?: string }>; model?: string; startedAt: number }

interface ChatEvent { type: string; data: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any

/** Direct chat over WebSocket: streaming tokens, live phases (thinking / typing / tool), stop and regenerate. */
export function useDirectChat(workspaceId: string, sessionId: string | undefined) {
  const qc = useQueryClient();
  const [streaming, setStreaming] = React.useState<StreamingMsg | null>(null);
  const [conn, setConn] = React.useState<SocketState>("connecting");
  const sock = React.useRef<ResilientSocket<ChatEvent> | null>(null);
  const key = qk.messages(workspaceId, sessionId ?? "");

  React.useEffect(() => {
    if (!sessionId) return;
    setStreaming(null);
    const upsert = (m: MessageOut) => qc.setQueryData<MessageOut[]>(key, (old = []) => (old.some((x) => x.id === m.id) ? old.map((x) => (x.id === m.id ? m : x)) : [...old, m]));
    const s = new ResilientSocket<ChatEvent>({
      url: () => wsUrl(`/ws/w/${workspaceId}/chat/${sessionId}`),
      onState: setConn,
      onEvent: (e) => {
        const d = e.data;
        switch (e.type) {
          case "message_created": upsert(d.message); break;
          case "message_deleted": qc.setQueryData<MessageOut[]>(key, (old = []) => old.filter((m) => m.id !== d.id)); break;
          case "stream_start": setStreaming({ id: d.message_id, text: "", phase: "thinking", detail: "Thinking…", tools: [], startedAt: Date.now() }); break;
          case "status": setStreaming((s0) => s0 && { ...s0, phase: d.phase, detail: d.detail, model: d.model ?? s0.model }); break;
          case "token_stream": setStreaming((s0) => s0 && { ...s0, text: s0.text + d.delta, phase: "writing" }); break;
          case "stream_reset": setStreaming((s0) => s0 && { ...s0, text: "" }); break;
          case "tool_call": setStreaming((s0) => s0 && { ...s0, tools: [...s0.tools, d.call] }); break;
          case "stream_end": setStreaming(null); upsert(d.message); qc.invalidateQueries({ queryKey: ["sessions"] }); break;
          case "error": toast.error(d.message); setStreaming((s0) => (s0 && !s0.text ? null : s0)); break;
        }
      },
    });
    sock.current = s;
    return () => { s.close(); sock.current = null; };
  }, [workspaceId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    conn, streaming,
    send: (content: string, attachments: ParsedFileOut[] = []) => sock.current?.send({ type: "user_message", content, attachments: attachments.map((a) => ({ filename: a.filename, text: a.text })) }),
    stop: () => sock.current?.send({ type: "stop" }),
    regenerate: () => sock.current?.send({ type: "regenerate" }),
  };
}
