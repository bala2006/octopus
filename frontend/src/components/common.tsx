import * as React from "react";
import { AlertTriangle, RotateCcw, type LucideIcon } from "lucide-react";
import { AVATARS, PERMISSIONS, statusMeta } from "@/lib/meta";
import { cn, initials } from "@/lib/utils";
import type { PermissionLevel } from "@/types";
import { Button } from "./ui/button";
import { Tip } from "./ui/overlays";

export function AgentAvatar({ name, color, avatar, status, size = 32, className }: {
  name: string; color: string; avatar?: string; status?: string; size?: number; className?: string;
}) {
  const Icon = avatar ? AVATARS[avatar] : undefined;
  const meta = status ? statusMeta(status) : null;
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <div
        className={cn("flex h-full w-full items-center justify-center rounded-full font-semibold text-white shadow-inner transition-shadow", meta?.live && "animate-pulse-ring")}
        style={{ background: `linear-gradient(135deg, ${color}, ${color}bb)`, fontSize: size * 0.36, ["--ring-color" as string]: `${meta?.color ?? color}88` }}
        aria-hidden
      >
        {Icon ? <Icon style={{ width: size * 0.5, height: size * 0.5 }} /> : initials(name)}
      </div>
      {meta && (
        <span
          className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background transition-colors")}
          style={{ width: Math.max(9, size * 0.32), height: Math.max(9, size * 0.32), background: meta.color }}
          aria-label={meta.label}
          title={meta.label}
        />
      )}
    </div>
  );
}

export function TypingDots({ color = "currentColor", className }: { color?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label="typing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 animate-typing-dot rounded-full" style={{ background: color, animationDelay: `${i * 0.15}s` }} />
      ))}
    </span>
  );
}

/** Status chip with icon, live shimmer text for the current activity. */
export function StatusPill({ status, activity, compact }: { status?: string; activity?: string; compact?: boolean }) {
  const m = statusMeta(status);
  const Icon = m.icon;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px]" role="status" aria-live="polite">
      <span className={cn("relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full")} style={{ background: `${m.color}22`, color: m.color }}>
        <Icon className={cn("h-2.5 w-2.5", m.live && status !== "awaiting_approval" && "animate-pulse")} />
      </span>
      {!compact && (
        <span className={cn("truncate", m.live ? "shimmer-text font-medium" : "text-muted-foreground")}>{activity || m.label}</span>
      )}
    </span>
  );
}

export function PermissionBadge({ level, className }: { level: PermissionLevel; className?: string }) {
  const p = PERMISSIONS[level] ?? PERMISSIONS.ask;
  const Icon = p.icon;
  return (
    <Tip content={<div className="max-w-[240px]"><div className="font-medium">{p.label}</div><div className="text-muted-foreground">{p.description}</div></div>}>
      <span className={cn("inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium", p.tone, className)}>
        <Icon className="h-3 w-3" />{p.short}
      </span>
    </Tip>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon: LucideIcon; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 p-8 text-center animate-fade-up", className)}>
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-muted/40 text-muted-foreground">
        <Icon className="h-6 w-6" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3" aria-busy>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-8 w-8 rounded-full" />
          <div className="flex-1 space-y-1.5"><div className="skeleton h-3 w-1/3" /><div className="skeleton h-3 w-2/3" /></div>
        </div>
      ))}
    </div>
  );
}

interface EBState { error: Error | null }
export class ErrorBoundary extends React.Component<{ children: React.ReactNode; label?: string }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("UI error", error, info.componentStack);
  }
  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8" role="alert">
        <div className="max-w-md space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <div className="flex items-center gap-2 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" />{this.props.label ?? "Something went wrong"}</div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{this.state.error.message}</pre>
          <Button size="sm" variant="outline" onClick={() => this.setState({ error: null })}><RotateCcw />Try again</Button>
        </div>
      </div>
    );
  }
}

export function ConnectionDot({ state }: { state: "connecting" | "open" | "reconnecting" | "closed" }) {
  const map = { open: ["bg-success", "Connected"], connecting: ["bg-warning animate-pulse", "Connecting…"], reconnecting: ["bg-warning animate-pulse", "Reconnecting…"], closed: ["bg-muted-foreground", "Offline"] } as const;
  const [cls, label] = map[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" role="status">
      <span className={cn("h-1.5 w-1.5 rounded-full", cls)} />{label}
    </span>
  );
}
