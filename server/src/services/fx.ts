/** USD exchange rates for showing costs in your currency (ECB rates via Frankfurter, ExchangeRate-API as fallback). */
import type { FxRateOut } from "@octopus/shared";
import { UserError } from "../lib/util";

const TTL = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; out: FxRateOut }>();

async function fetchRate(currency: string): Promise<FxRateOut> {
  try {
    const r = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${currency}`, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { rates?: Record<string, number>; date?: string };
    if (j.rates?.[currency]) return { currency, rate: j.rates[currency]!, base: "USD", date: j.date, source: "ECB via Frankfurter", stale: false };
  } catch { /* try the fallback */ }
  const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as { rates?: Record<string, number>; time_last_update_utc?: string };
  if (!j.rates?.[currency]) throw new UserError(`No exchange rate for ${currency}`, 404);
  return { currency, rate: j.rates[currency]!, base: "USD", date: j.time_last_update_utc, source: "ExchangeRate-API", stale: false };
}

export async function usdRate(raw = "USD"): Promise<FxRateOut> {
  const currency = raw.toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(currency)) throw new UserError("Use a 3-letter currency code");
  if (currency === "USD") return { currency, rate: 1, base: "USD", source: "identity", stale: false };
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < TTL) return hit.out;
  try {
    const out = await fetchRate(currency);
    cache.set(currency, { at: Date.now(), out });
    return out;
  } catch (e) {
    if (hit) return { ...hit.out, stale: true };
    throw e instanceof UserError ? e : new UserError("Exchange rates are unavailable offline", 503);
  }
}
