import { Circle, CircleCheck, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoState } from "./runState";

const STATUS = {
  completed: { icon: CircleCheck, label: "done", className: "text-success" },
  in_progress: { icon: CircleDot, label: "in progress", className: "text-warning" },
  pending: { icon: Circle, label: "to do", className: "text-muted-foreground" },
} as const;

/** The main agent's todo list, above the feed. Each item shows its status in words as well as in its icon. */
export function TodoList({ todos }: { todos: TodoState }) {
  const done = todos.items.filter((t) => t.status === "completed").length;
  return (
    <section aria-label="Todo list" data-testid="todo-list" className="shrink-0 border-b border-border px-3 py-2 text-xs">
      <h3 className="mb-1.5 flex items-center gap-2 font-semibold">
        To do <span className="font-normal tabular-nums text-muted-foreground">{done} of {todos.items.length} done</span>
      </h3>
      <ul className="max-h-32 space-y-1 overflow-y-auto">
        {todos.items.map((t, i) => {
          const meta = STATUS[t.status];
          const Icon = meta.icon;
          return (
            <li key={`${i}-${t.content}`} className={cn("flex items-start gap-2", t.status === "completed" && "text-muted-foreground line-through")}>
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", meta.className)} aria-hidden="true" />
              <span className="min-w-0 leading-snug">{t.content}</span>
              <span className="sr-only">({meta.label})</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
