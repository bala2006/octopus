import { DEFAULT_BUDGET, type RunBudget } from "@octopus/shared";

/** Defaults for new conversations (quick composer and the advanced dialog). */
export const defaultRunBudget = (): Required<Omit<RunBudget, "model">> & { model: string | null } => ({ ...DEFAULT_BUDGET });
