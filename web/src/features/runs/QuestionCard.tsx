import * as React from "react";
import { Check, MessageSquareReply, PenLine, Send, Sparkles } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { AgentOut } from "@/types";

export interface QuestionChoice { label: string; description?: string; recommended?: boolean }
export interface AwaitingQuestion { agent_id: string; question: string; options?: QuestionChoice[]; allow_other?: boolean }

/**
 * An agent's question for the user: pick one of the offered answers (the best one is marked Recommended)
 * or type your own. Keyboard: 1-9 picks an option, Enter sends.
 */
export function QuestionCard({ awaiting, agent, onAnswer }: { awaiting: AwaitingQuestion; agent?: AgentOut; onAnswer: (text: string) => void }) {
  const options = awaiting.options ?? [];
  const [picked, setPicked] = React.useState<number | "other">(() => {
    const r = options.findIndex((o) => o.recommended);
    return options.length ? (r >= 0 ? r : 0) : "other";
  });
  const [other, setOther] = React.useState("");
  const otherRef = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { if (picked === "other") otherRef.current?.focus(); }, [picked]);

  const answer = picked === "other" ? other.trim() : options[picked]?.label ?? "";
  const send = () => {
    if (!answer) return;
    const o = picked === "other" ? null : options[picked];
    onAnswer(o ? `${o.label}${o.description ? ` (${o.description})` : ""}` : answer);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
    const n = Number(e.key);
    if (n >= 1 && n <= options.length) { e.preventDefault(); setPicked(n - 1); }
    if (e.key === "Enter") { e.preventDefault(); send(); }
  };

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 animate-in fade-in-0 slide-in-from-bottom-1" role="group"
      aria-label={`${agent?.name ?? "An agent"} asks you`} onKeyDown={onKey}>
      <div className="mb-2 flex items-start gap-2">
        {agent ? <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} size={22} /> : <MessageSquareReply className="h-4 w-4 text-warning" />}
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">{agent?.name ?? "An agent"} needs your answer</span>
          <Markdown className="text-sm">{awaiting.question}</Markdown>
        </div>
      </div>
      <div role="radiogroup" aria-label="Answers" className="grid gap-1.5 sm:grid-cols-2">
        {options.map((o, i) => (
          <button key={i} type="button" role="radio" aria-checked={picked === i} onClick={() => setPicked(i)} onDoubleClick={() => { setPicked(i); onAnswer(o.label); }}
            className={cn("group flex items-start gap-2 rounded-lg border bg-card p-2.5 text-left text-sm transition hover:border-primary/60",
              picked === i ? "border-primary ring-1 ring-primary/40" : "border-border")}>
            <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
              picked === i ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}>
              {picked === i ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 font-medium">{o.label}
                {o.recommended && <span className="inline-flex items-center gap-0.5 rounded-full bg-olive/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-olive"><Sparkles className="h-2.5 w-2.5" />Recommended</span>}
              </span>
              {o.description && <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>}
            </span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={picked === "other"} onClick={() => setPicked("other")}
          className={cn("flex items-start gap-2 rounded-lg border border-dashed bg-card p-2.5 text-left text-sm transition hover:border-primary/60",
            picked === "other" ? "border-primary ring-1 ring-primary/40" : "border-border", !options.length && "sm:col-span-2")}>
          <span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
            picked === "other" ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground")}><PenLine className="h-3 w-3" /></span>
          <span><span className="font-medium">Something else</span><span className="block text-xs text-muted-foreground">Type your own answer</span></span>
        </button>
      </div>
      {picked === "other" && (
        <Textarea ref={otherRef} value={other} onChange={(e) => setOther(e.target.value)} rows={2} placeholder="Type your answer…" aria-label="Your answer"
          className="mt-2 min-h-[56px] text-sm" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        {options.length > 0 && <span className="mr-auto text-[11px] text-muted-foreground">Press 1-{options.length} to pick, Enter to send</span>}
        <Button size="sm" onClick={send} disabled={!answer}><Send />Send answer</Button>
      </div>
    </div>
  );
}
