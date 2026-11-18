/**
 * A browser budget for one turn or one specialist round. Browser calls past the limit return a refusal and do not run, so a
 * pass that would click through every flow stops at the limit and says what it did not check.
 */
import type { Tool, ToolResult } from "./types";

/** The text a refused browser call returns. It tells the agent to finish, not to retry. */
export const budgetSpent = (limit: number) =>
  `The browser budget for this turn is spent (${limit} calls). Stop using the browser. Finish with what you checked, and name what you did not check.`;

/** The tools with the browser calls limited to `limit` in all. Other tools pass through unchanged. */
export function browserBudget(tools: Tool[], limit: number): Tool[] {
  let used = 0;
  return tools.map((tool) => {
    if (!tool.name.startsWith("browser_")) return tool;
    return {
      ...tool,
      run: (ctx, args, callId): Promise<ToolResult> => {
        if (used >= limit) return Promise.resolve({ text: budgetSpent(limit), ok: false });
        used++;
        return tool.run(ctx, args, callId);
      },
    };
  });
}
