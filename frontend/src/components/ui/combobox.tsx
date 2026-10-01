/**
 * Searchable, grouped single-select (recognition over recall: pick from what exists instead of typing it).
 * Keyboard: type to filter, ↑/↓ to move, Enter to pick, Esc to close. Optional "create" row for new values.
 */
import * as React from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./overlays";

export interface ComboOption { value: string; label: string; group?: string; hint?: string; icon?: React.ReactNode; keywords?: string }

export function Combobox({ value, options, onChange, placeholder = "Select…", ariaLabel, className, onCreate, createLabel = "Create",
  renderValue, disabled, testId }: {
  value: string; options: ComboOption[]; onChange: (v: string) => void; placeholder?: string; ariaLabel?: string; className?: string;
  /** shows "Create “query”" when the query matches nothing exactly */
  onCreate?: (query: string) => void; createLabel?: string;
  renderValue?: (o: ComboOption | undefined) => React.ReactNode; disabled?: boolean; testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => `${o.label} ${o.group ?? ""} ${o.hint ?? ""} ${o.keywords ?? ""}`.toLowerCase().includes(needle)) : options;
  const canCreate = !!onCreate && !!needle && !options.some((o) => o.label.toLowerCase() === needle);
  const rows = shown.length + (canCreate ? 1 : 0);
  React.useEffect(() => { if (open) { setQ(""); setActive(Math.max(0, options.findIndex((o) => o.value === value))); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const pick = (i: number) => {
    if (i < shown.length) onChange(shown[i].value);
    else if (canCreate) onCreate!(q.trim());
    setOpen(false);
  };
  let lastGroup: string | undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button type="button" aria-label={ariaLabel} aria-haspopup="listbox" data-testid={testId}
          className={cn("flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-left text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50", className)}>
          <span className="min-w-0 flex-1 truncate">{renderValue ? renderValue(current) : current ? <>{current.icon}{current.label}</> : <span className="text-muted-foreground">{placeholder}</span>}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[220px] p-0">
        <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input autoFocus value={q} placeholder="Search…" aria-label="Search options" className="h-6 w-full bg-transparent text-sm outline-none"
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows - 1, a + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === "Enter" && rows) { e.preventDefault(); pick(Math.min(active, rows - 1)); }
            }} />
        </div>
        <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto p-1">
          {shown.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <React.Fragment key={o.value}>
                {header && <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground first:pt-1">{header}</div>}
                <button type="button" role="option" aria-selected={o.value === value} data-idx={i} onMouseEnter={() => setActive(i)} onClick={() => pick(i)}
                  className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm", i === active && "bg-accent")}>
                  {o.icon}
                  <span className="min-w-0 flex-1"><span className="block truncate">{o.label}</span>
                    {o.hint && <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span>}</span>
                  {o.value === value && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              </React.Fragment>
            );
          })}
          {canCreate && (
            <button type="button" data-idx={shown.length} onMouseEnter={() => setActive(shown.length)} onClick={() => pick(shown.length)}
              className={cn("flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-primary", active === shown.length && "bg-accent")}>
              <Plus className="h-3.5 w-3.5" />{createLabel} “{q.trim()}”
            </button>
          )}
          {!rows && <div className="px-2 py-3 text-center text-xs text-muted-foreground">Nothing matches “{q}”.</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
