import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { PERMISSIONS } from "@/lib/meta";
import type { PermissionLevel } from "@/types";

export function PermissionPicker({
  value,
  onChange,
  compact,
}: {
  value: PermissionLevel;
  onChange: (value: PermissionLevel) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Permission level"
      className={cn("grid gap-2", compact ? "grid-cols-4" : "grid-cols-2")}
    >
      {(Object.keys(PERMISSIONS) as PermissionLevel[]).map((key) => {
        const permission = PERMISSIONS[key];
        const Icon = permission.icon;
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(key)}
            className={cn(
              "group relative rounded-lg border p-2.5 text-left transition-all hover:border-primary/50 hover:bg-accent/40",
              active
                ? "border-primary bg-primary/5 shadow-sm shadow-primary/10"
                : "border-border",
            )}
          >
            <div className="flex items-center gap-1.5 text-xs font-semibold">
              <Icon className={cn("h-3.5 w-3.5", permission.tone)} />
              {compact ? permission.short : permission.label}
              {active && (
                <Check className="ml-auto h-3.5 w-3.5 animate-in zoom-in-50 text-primary" />
              )}
            </div>
            {!compact && (
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {permission.description}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
