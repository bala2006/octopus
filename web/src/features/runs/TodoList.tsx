import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoState } from "./runState";

const STATUS = {
  completed: { icon: CircleCheck, label: "done", iconClass: "text-success", textClass: "text-muted-foreground line-through" },
  in_progress: { icon: CircleDot, label: "in progress", iconClass: "text-warning", textClass: "font-medium text-foreground" },
  pending: { icon: Circle, label: "to do", iconClass: "text-muted-foreground", textClass: "text-foreground/90" },
} as const;

/**
 * The main agent's checklist in a card, styled like a review round: a title with a count pill, a progress bar,
 * then one row per item. The status shows as an icon, a text style, and a word for screen readers.
 */
export function TodoList({ todos }: { todos: TodoState }) {
  const total = todos.items.length;
  const done = todos.items.filter((t) => t.status === "completed").length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <section aria-label="To do" data-testid="todo-list" className="shrink-0 p-3">
      <div className="rounded-xl bg-card p-3 text-xs">
        <header className="mb-2.5 flex items-center justify-between gap-3 px-1">
          <h3 className="text-[13px] font-semibold">To do</h3>
          <p className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{done} of {total} done</p>
        </header>
        <div role="progressbar" aria-label="Checklist progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="mx-1 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        <ol className="mt-2 divide-y divide-border/60 px-1">
          {todos.items.map((t, i) => {
            const meta = STATUS[t.status];
            const Icon = meta.icon;
            return (
              <li key={`${i}-${t.content}`} className="grid grid-cols-[14px_minmax(0,1fr)] items-start gap-3 py-2.5 text-[13px] leading-5 first:pt-2 last:pb-0">
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
