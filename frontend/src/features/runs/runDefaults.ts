import type { RunBudget } from "@/types";

/** Shared defaults for quick workbench requests and the advanced run dialog. */
export const defaultRunBudget = (): RunBudget => ({
  max_turns: 60,
  max_tokens: 400000,
  max_cost_usd: 2,
  timeout_s: 900,
  loop_threshold: 0.92,
  max_loop_strikes: 3,
  stall_turns: 30,
  max_tool_rounds: 40,
  context_recent: 30,
  max_agents: 24,
  persist_team: true,
  verify_before_finish: true,
  workflow: "auto",
  force_mock: false,
  reasoning_effort: "default",
});
