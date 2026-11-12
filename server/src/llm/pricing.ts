/** gpt-6-luna Standard rates (USD per 1M tokens). Overridable per user in Settings → Model → Advanced. */
import type { ProviderOptions } from "@octopus/shared";

export interface TokenUsage { input: number; cached: number; output: number; reasoning: number }
export const RATES = { input: 0.1, cached_input: 0.01, output: 0.5 };
const LONG_PROMPT = 272_000;

export function costParts(u: TokenUsage, options: ProviderOptions = {}) {
  const r = { ...RATES, ...(options.pricing ?? {}) };
  const long = u.input > LONG_PROMPT;
  const zone = options.deployment_type && options.deployment_type !== "global" ? 1.1 : 1;
  const m = 1_000_000;
  return {
    input: (Math.max(0, u.input - u.cached) * r.input * (long ? 2 : 1) * zone) / m,
    cached_input: (u.cached * r.cached_input * (long ? 2 : 1) * zone) / m,
    output: (u.output * r.output * (long ? 1.5 : 1) * zone) / m,
  };
}

export const priceUsage = (u: TokenUsage, options: ProviderOptions = {}) => {
  const p = costParts(u, options);
  return p.input + p.cached_input + p.output;
};
