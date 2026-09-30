import * as React from "react";
import { CheckCheck, Check, FilePen, Flag, Plug, ShieldQuestion, Terminal, X } from "lucide-react";
import { diffStats, hunks, lineDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";
import type { AgentOut, PendingApproval } from "@/types";
import { AgentAvatar } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";

const KIND = {
  write_file: { icon: FilePen, label: "Write file" }, run_code: { icon: Terminal, label: "Run command" },
  mcp_call: { icon: Plug, label: "MCP tool call" }, finish: { icon: Flag, label: "Finish" },
} as Record<string, { icon: typeof FilePen; label: string }>;

/** Human-in-the-loop approval with a diff / command preview. Keyboard: A approve, Shift+A always, R reject. */
export function ApprovalCard({ approval, agent, onDecide }: {
  approval: PendingApproval; agent?: AgentOut; onDecide: (approved: boolean, scope: "once" | "always", reason?: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const [rejecting, setRejecting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const k = KIND[approval.kind] ?? { icon: ShieldQuestion, label: approval.kind };
  const d = approval.details ?? {};
  const diff = React.useMemo(() => (approval.kind === "write_file" ? lineDiff(String(d.old ?? ""), String(d.new ?? approval.preview)) : []), [approval, d.old, d.new]);
  const stats = diffStats(diff);
  const decide = (ok: boolean, scope: "once" | "always" = "once") => { setBusy(true); onDecide(ok, scope, reason); };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === "a" || e.key === "A") { e.preventDefault(); decide(true, e.shiftKey ? "always" : "once"); }
      if (e.key === "r") { e.preventDefault(); setRejecting(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="overflow-hidden rounded-xl border border-warning/50 bg-elevated shadow-xl shadow-warning/5 animate-in fade-in-0 slide-in-from-bottom-2" role="alertdialog" aria-label="Approval required">
      <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2">
        <ShieldQuestion className="h-4 w-4 animate-pulse text-warning" />
        <span className="text-xs font-semibold text-warning">Approval required</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {agent && <AgentAvatar name={agent.name} color={agent.color} avatar={agent.avatar} size={18} />}
          <k.icon className="h-3.5 w-3.5" />{k.label}
        </span>
      </div>
      <div className="space-y-2 p-3">
        <p className="text-sm font-medium">{approval.summary}</p>
        {approval.kind === "write_file" && (
          <div className="overflow-hidden rounded-md border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-2 py-1 font-mono text-[11px]">
              <span className="truncate">{d.path}</span>
              <span className="ml-auto text-success">+{stats.added}</span><span className="text-destructive">−{stats.removed}</span>
            </div>
            <div className="max-h-56 overflow-auto bg-background font-mono text-[11px] leading-[1.45]">
              {hunks(diff).map((l, i) => l.kind === "gap"
                ? <div key={i} className="bg-muted/40 px-2 text-[10px] text-muted-foreground">⋯ {l.count} unchanged lines</div>
                : <div key={i} className={cn("whitespace-pre px-2", l.kind === "add" && "bg-success/10 text-success", l.kind === "del" && "bg-destructive/10 text-destructive line-through decoration-destructive/40")}>
                    <span className="mr-2 inline-block w-3 select-none opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text || " "}
                  </div>)}
            </div>
            {d.note && <div className="border-t border-border px-2 py-1 text-[11px] text-muted-foreground">Why: {d.note}</div>}
          </div>
        )}
        {approval.kind === "run_code" && <pre className="rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs"><span className="text-muted-foreground">$ </span>{d.command}</pre>}
        {approval.kind === "mcp_call" && <pre className="max-h-40 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px]">{d.server}/{d.tool}({JSON.stringify(d.arguments, null, 2)})</pre>}
        {approval.kind === "finish" && <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{d.summary || approval.preview}</p>}
        {rejecting && (
          <Input autoFocus placeholder="Tell the agent why (optional), then press Enter" value={reason} onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") decide(false); if (e.key === "Escape") setRejecting(false); }} className="h-8 text-xs" />
        )}
      </div>
      <div className="flex items-center gap-1.5 border-t border-border bg-surface px-3 py-2">
        <span className="hidden text-[10px] text-muted-foreground sm:block"><kbd className="kbd">A</kbd> approve · <kbd className="kbd">⇧A</kbd> always · <kbd className="kbd">R</kbd> reject</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={busy} onClick={() => (rejecting ? decide(false) : setRejecting(true))}><X />Reject</Button>
          {approval.kind !== "finish" && <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(true, "always")}><CheckCheck />Always allow</Button>}
          <Button size="sm" variant="success" loading={busy} onClick={() => decide(true)} data-testid="approve"><Check />Approve</Button>
        </div>
      </div>
    </div>
  );
}
