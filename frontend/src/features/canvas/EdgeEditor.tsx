import * as React from "react";
import { toast } from "sonner";
import { ArrowLeftRight, ArrowRight, Trash2, X } from "lucide-react";
import { EDGE_TYPES } from "@/lib/meta";
import { cn } from "@/lib/utils";
import { useCanvas } from "@/stores/canvas";
import type { EdgeType } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";

/** Floating panel to configure a communication channel (type, direction, label, limits, handoff, condition). */
export function EdgeEditor() {
  const id = useCanvas((s) => s.edgeEditId);
  const edge = useCanvas((s) => s.edges.find((e) => e.id === s.edgeEditId));
  const nodes = useCanvas((s) => s.nodes);
  const updateEdge = useCanvas((s) => s.updateEdge);
  const deleteEdge = useCanvas((s) => s.deleteEdge);
  const close = () => useCanvas.getState().setEdgeEdit(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!id || !edge?.data) return null;
  const d = edge.data;
  const src = nodes.find((n) => n.id === edge.source)?.data;
  const dst = nodes.find((n) => n.id === edge.target)?.data;
  const patch = (p: Parameters<typeof updateEdge>[1]) => {
    const r = updateEdge(id, p);
    if (!r.ok && r.reason) toast.error(r.reason);
  };
  const swap = () => {
    const s = useCanvas.getState();
    useCanvas.setState({ edges: s.edges.map((e) => (e.id === id ? { ...e, source: e.target, target: e.source } : e)), version: s.version + 1 });
  };

  return (
    <div className="absolute bottom-3 right-3 top-14 z-20 flex w-[320px] max-w-[calc(100%-1.5rem)] flex-col pointer-events-none" role="presentation">
    <div className="pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl animate-in fade-in-0 slide-in-from-right-2" role="dialog" aria-label="Channel settings">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Channel</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={close} aria-label="Close"><X /></Button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3">
        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 p-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">{src && <AgentAvatar name={src.name} color={src.color} avatar={src.avatar} size={20} />}<span className="truncate">{src?.name}</span></span>
          <button onClick={() => patch({ bidirectional: !d.bidirectional })} className="rounded-md border border-border px-2 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="Toggle direction" title={d.bidirectional ? "Bidirectional: click for one-way" : "One-way: click for bidirectional"}>
            {d.bidirectional ? <ArrowLeftRight className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </button>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium"><span className="truncate">{dst?.name}</span>{dst && <AgentAvatar name={dst.name} color={dst.color} avatar={dst.avatar} size={20} />}</span>
        </div>
        {!d.bidirectional && <button onClick={swap} className="text-[11px] text-primary hover:underline">Reverse direction</button>}

        <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Channel type">
          {(Object.keys(EDGE_TYPES) as EdgeType[]).map((t) => {
            const m = EDGE_TYPES[t];
            const on = d.type === t;
            return (
              <button key={t} role="radio" aria-checked={on} title={m.description} onClick={() => patch({ type: t })}
                className={cn("rounded-md border px-1 py-1.5 text-[10.5px] font-medium transition-all active:scale-95", on ? "shadow-sm" : "border-border text-muted-foreground hover:bg-accent/50")}
                style={on ? { borderColor: m.color, color: m.color, background: `${m.color}14` } : undefined}>{m.label}</button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{EDGE_TYPES[d.type].description}</p>
        <Field label="Label"><Input className="h-8" value={d.label} onChange={(e) => patch({ label: e.target.value })} placeholder={EDGE_TYPES[d.type].label} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Max turns"><Input className="h-8" type="number" min={1} max={500} value={d.config.max_turns} onChange={(e) => patch({ config: { ...d.config, max_turns: Math.max(1, +e.target.value || 1) } })} /></Field>
          {d.type === "debate" && <Field label="Max rounds"><Input className="h-8" type="number" min={1} max={50} value={d.config.max_rounds} onChange={(e) => patch({ config: { ...d.config, max_rounds: Math.max(1, +e.target.value || 1) } })} /></Field>}
          {d.type === "review" && <Field label="Max revisions"><Input className="h-8" type="number" min={1} max={50} value={d.config.max_revisions} onChange={(e) => patch({ config: { ...d.config, max_revisions: Math.max(1, +e.target.value || 1) } })} /></Field>}
        </div>
        <Field label="Handoff instructions" hint="Injected into the sender's prompt for this channel.">
          <Textarea className="min-h-[56px] text-xs" value={d.config.handoff_instructions} onChange={(e) => patch({ config: { ...d.config, handoff_instructions: e.target.value } })} placeholder="Include acceptance criteria and file paths" />
        </Field>
        <Field label="Condition (optional)" hint='Natural language, checked by a gatekeeper model before delivery, e.g. "only if tests pass".'>
          <Input className="h-8 text-xs" value={d.config.condition} onChange={(e) => patch({ config: { ...d.config, condition: e.target.value } })} placeholder="only if code is ready" />
        </Field>
      </div>
      <div className="flex shrink-0 justify-end border-t border-border bg-surface px-2 py-1.5">
        <Button variant="ghost" size="xs" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => deleteEdge(id)}><Trash2 />Delete channel</Button>
      </div>
    </div>
    </div>
  );
}
