import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/overlays";

export type Effort = "default" | "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** gpt-6-luna reasoning effort (sent as `reasoning.effort`). More effort = better answers on hard work, more tokens and time. */
export const EFFORTS: { value: Effort; label: string; hint: string }[] = [
  { value: "default", label: "Auto", hint: "The model's own default (medium)" },
  { value: "none", label: "None", hint: "No reasoning: fastest, cheapest; fine for simple replies" },
  { value: "low", label: "Low", hint: "Quick thinking for routine tasks" },
  { value: "medium", label: "Medium", hint: "Balanced (the model default)" },
  { value: "high", label: "High", hint: "Deeper thinking for design, reviews and tricky bugs" },
  { value: "xhigh", label: "X-High", hint: "Very thorough; noticeably slower" },
  { value: "max", label: "Max", hint: "Maximum reasoning for the hardest problems; slowest and most tokens" },
];

export function EffortPicker({ value, onChange, allowDefault = true, defaultLabel, compact }: {
  value: Effort; onChange: (v: Effort) => void; allowDefault?: boolean; defaultLabel?: string; compact?: boolean;
}) {
  const items = EFFORTS.filter((e) => allowDefault || e.value !== "default");
  return (
    <div role="radiogroup" aria-label="Reasoning effort" className={cn("flex flex-wrap gap-1", compact && "gap-0.5")}>
      {items.map((e) => {
        const on = value === e.value;
        return (
          <Tip key={e.value} content={e.hint}>
            <button type="button" role="radio" aria-checked={on} aria-label={`Effort ${e.label}`} onClick={() => onChange(e.value)}
              className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition hover:border-primary/60",
                on ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground")}>
              {e.value === "max" && <Brain className="h-3 w-3" />}
              {e.value === "default" && defaultLabel ? defaultLabel : e.label}
            </button>
          </Tip>
        );
      })}
    </div>
  );
}
