/** The task list the agent keeps for multi-step work. Each call replaces the whole list, and the run event carries it. */
import { z } from "zod";
import { defineTool } from "./types";

export const todoTools = [
  defineTool({
    name: "todo_write",
    description: "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done.",
    args: z.object({
      todos: z.array(z.object({
        content: z.string().min(1).describe("What the task is: a short imperative line"),
        status: z.enum(["pending", "in_progress", "completed"]).describe("pending (not started) | in_progress (now) | completed (done)"),
      })).describe("The complete task list, replacing any previous list"),
    }),
    async run(ctx, a) {
      ctx.emit("todo_updated", { agent_id: ctx.agent.id, todos: a.todos });
      const count = (status: string) => a.todos.filter((t) => t.status === status).length;
      return { text: `Updated todo list: ${count("pending")} pending, ${count("in_progress")} in progress, ${count("completed")} completed.` };
    },
  }),
];
