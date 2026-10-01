import * as React from "react";
import { Brain, FileCode2, MessageSquareText, PenLine, Terminal, Wrench } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import { humanizeStream, tailLines, type Segment } from "./streamView";

const ICON = { thought: Brain, code: FileCode2, message: MessageSquareText, command: Terminal, status: Wrench, text: PenLine } as const;

/** Keeps a scrolling box pinned to its newest line while text streams in. */
function useStickToBottom(dep: unknown) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [dep]);
  return ref;
}

/** What the agent is thinking (its reasoning summary), as readable paragraphs. */
export function ThinkingView({ text, live, compact }: { text: string; live?: boolean; compact?: boolean }) {
  const box = useStickToBottom(text);
  if (!text.trim()) return null;
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5" data-testid="agent-thinking">
      <div className="mb-0.5 flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        <Brain className={cn("h-3 w-3", live && "animate-pulse")} />{live ? "Thinking…" : "Thought"}
      </div>
      <div ref={box} className={cn("overflow-y-auto text-[12px] leading-relaxed text-muted-foreground [&_p]:my-1 [&_strong]:text-foreground/85",
        compact ? "max-h-24" : "max-h-48")}>
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

function SegmentView({ seg, lines }: { seg: Segment; lines: number }) {
  const Icon = ICON[seg.kind];
  const box = useStickToBottom(seg.body);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground/80">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{seg.title}</span>
        {seg.language && <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground">{seg.language}</span>}
      </div>
      {seg.body && (seg.kind === "code" || seg.kind === "command" ? (
        // code keeps its own lines and indentation; long lines scroll sideways instead of being broken mid-token
        <div ref={box} className="max-h-56 overflow-auto rounded-md border border-border/60 bg-background/70">
          <pre className="w-max min-w-full whitespace-pre p-2 font-mono text-[11px] leading-[1.55] text-foreground/85" data-testid="live-code">{tailLines(seg.body, lines)}</pre>
        </div>
      ) : (
        <div ref={box} className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-muted-foreground" data-testid="live-text">
          {seg.body}
        </div>
      ))}
    </div>
  );
}

/** Human-readable view of what an agent is streaming: thoughts as paragraphs, code laid out line by line. */
export function LiveWriting({ raw, lines = 40, max = 2 }: { raw: string; lines?: number; max?: number }) {
  const segs = React.useMemo(() => humanizeStream(raw), [raw]);
  if (!segs.length) return null;
  return <div className="space-y-2" data-testid="live-writing">{segs.slice(-max).map((s, i) => <SegmentView key={`${i}-${s.title}`} seg={s} lines={lines} />)}</div>;
}

/** One-line summary for small surfaces (canvas nodes): "Writing src/game.js · function loop() {". */
export function liveSummary(raw: string): { title: string; line: string } | null {
  const seg = humanizeStream(raw).at(-1);
  if (!seg) return null;
  const line = seg.body.replace(/\s+$/, "").split("\n").filter((l) => l.trim()).at(-1)?.trim() ?? "";
  return { title: seg.title, line };
}
