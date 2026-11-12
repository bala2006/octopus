import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { formatCost } from "@/lib/utils";
import { useApp } from "@/stores/app";

/** Currencies offered in Settings (any ISO code can be typed in). */
export const CURRENCIES: { code: string; label: string; locale: string }[] = [
  { code: "USD", label: "US dollar", locale: "en-US" },
  { code: "INR", label: "Indian rupee", locale: "en-IN" },
  { code: "EUR", label: "Euro", locale: "de-DE" },
  { code: "GBP", label: "British pound", locale: "en-GB" },
  { code: "JPY", label: "Japanese yen", locale: "ja-JP" },
  { code: "AUD", label: "Australian dollar", locale: "en-AU" },
  { code: "CAD", label: "Canadian dollar", locale: "en-CA" },
  { code: "SGD", label: "Singapore dollar", locale: "en-SG" },
  { code: "AED", label: "UAE dirham", locale: "en-AE" },
];

export function formatMoney(usd: number, currency: string, rate: number): string {
  if (currency === "USD" || !rate) return formatCost(usd);
  const v = usd * rate;
  const locale = CURRENCIES.find((c) => c.code === currency)?.locale;
  const digits = !v ? 0 : Math.abs(v) < 0.0001 ? 6 : Math.abs(v) < 0.01 ? 4 : Math.abs(v) < 1 ? 3 : 2;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: v ? Math.min(digits, 2) : 0, maximumFractionDigits: digits }).format(v);
  } catch {
    return `${v.toFixed(digits)} ${currency}`;
  }
}

/** Live USD→display-currency rate (cached 6h server-side, 1h here). Falls back to USD if rates are unavailable. */
export function useFxRate() {
  const currency = useApp((s) => s.currency || "USD");
  const q = useQuery({
    queryKey: ["fx", currency], enabled: currency !== "USD", staleTime: 3600_000, retry: 1,
    queryFn: () => unwrap(api.GET("/api/v1/settings/fx", { params: { query: { currency } } })),
  });
  const ok = currency === "USD" || !!q.data;
  return { currency: ok ? currency : "USD", rate: currency === "USD" ? 1 : q.data?.rate ?? 0, info: q.data, error: q.error as Error | null, loading: q.isLoading };
}

/** `money(usd)` formats a USD amount in the user's display currency. */
export function useMoney() {
  const { currency, rate } = useFxRate();
  return (usd: number) => formatMoney(usd, currency, rate);
}
