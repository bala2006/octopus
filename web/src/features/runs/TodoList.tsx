import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoState } from "./runState";

const STATUS = {
  completed: { icon: CircleCheck, label: "done", iconClass: "text-success", textClass: "text-muted-foreground line-through" },
  in_progress: { icon: CircleDot, label: "in progress", iconClass: "text-warning", textClass: "font-medium text-foreground" },
  pending: { icon: Circle, label: "to do", iconClass: "text-muted-foreground", textClass: "text-foreground/90" },
} as const;

/**
 * The main agent's checklist: a count, a progress bar, then each item. The status shows as an icon, a text style, and a word for screen readers.
 */
export function TodoList({ todos }: { todos: TodoState }) {
  const total = todos.items.length;
  const done = todos.items.filter((t) => t.status === "completed").length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <section aria-label="To do" data-testid="todo-list" className="shrink-0 border-b border-border px-3 py-3">
      <div className="rounded-lg border border-border bg-muted/20 p-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">To do</h3>
          <p className="text-[11px] tabular-nums text-muted-foreground">{done} of {total} done</p>
        </div>
        <div role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        <ol className="mt-2 space-y-0.5">
          {todos.items.map((t, i) => {
            const meta = STATUS[t.status];
            const Icon = meta.icon;
            return (
              <li key={`${i}-${t.content}`} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 rounded-md px-1 py-1 text-[13px] leading-5 hover:bg-muted/40">
                <Icon className={cn("mt-[3px] h-3.5 w-3.5", meta.iconClass)} aria-hidden="true" />
                <span className={cn("min-w-0 break-words", meta.textClass)}>
                  {t.content}
                  <span className="sr-only"> ({meta.label})</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
