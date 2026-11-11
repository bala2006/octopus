/** Settings → Plugins: every plugin Octopus is built from, what it provides and needs, its health, and a switch.
 * Switching a plugin off also offers to switch off the plugins that need it. Parts of the run loop have no switch. */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Lock, Search } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePlugins } from "@/hooks/queries";
import type { PluginOut } from "@/types";
import { Badge, Input, Switch } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/ui/overlays";

export const SLOT_LABELS: Record<string, string> = {
  kernel: "Kernel", channel: "Channels", provider: "Model providers", tool: "Tools", workflow: "Workflows", role: "Roles",
  knowledge: "Knowledge", runner: "Sandbox", workspace: "Workspace", observer: "Observers", service: "Services",
};
const SLOT_ORDER = Object.keys(SLOT_LABELS);

/** Group plugins by slot in the order the architecture lists them; unknown slots go last. Optional text filter on id/title/capabilities. */
export function groupPlugins(plugins: PluginOut[], query = ""): [string, PluginOut[]][] {
  const needle = query.trim().toLowerCase();
  const match = (p: PluginOut) => !needle || [p.id, p.title, p.description, ...p.provides, ...p.requires].join(" ").toLowerCase().includes(needle);
  const groups = new Map<string, PluginOut[]>();
  for (const p of plugins.filter(match)) groups.set(p.slot, [...(groups.get(p.slot) ?? []), p]);
  const rank = (slot: string) => (SLOT_ORDER.includes(slot) ? SLOT_ORDER.indexOf(slot) : SLOT_ORDER.length);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export function stateBadge(p: Pick<PluginOut, "enabled" | "state" | "health" | "status">): { label: string; variant: "success" | "warning" | "destructive" | "secondary" } {
  if (p.state === "failed") return { label: "Failed", variant: "destructive" };
  if (p.state === "blocked") return { label: "Blocked", variant: "warning" };
  if (!p.enabled || p.state === "disabled") return { label: "Off", variant: "secondary" };
  if (p.status === "planned") return { label: "Planned", variant: "secondary" };
  if (p.health.state === "degraded") return { label: "Degraded", variant: "warning" };
  if (p.health.state === "failed") return { label: "Unhealthy", variant: "destructive" };
  return { label: "On", variant: "success" };
}

export function PluginsSection() {
  const { data, isLoading } = usePlugins();
  const qc = useQueryClient();
  const [q, setQ] = React.useState("");
  const [ask, setAsk] = React.useState<null | { plugin: PluginOut; enabled: boolean; others: string[] }>(null);
  const toggle = useMutation({
    mutationFn: async (v: { id: string; enabled: boolean; cascade: boolean }) => {
      const { data: out, error, response } = await api.PATCH("/api/v1/plugins/{plugin_id}", { params: { path: { plugin_id: v.id } }, body: { enabled: v.enabled, cascade: v.cascade } });
      if (error || !out) throw new Error(((error as { detail?: string } | undefined)?.detail) ?? `Request failed (${response.status})`);
      return out;
    },
    onSuccess: (out, v) => {
      qc.setQueryData(["plugins"], out.state);
      toast.success(`${v.enabled ? "Switched on" : "Switched off"} ${out.changed.length > 1 ? `${out.changed.length} plugins` : out.changed[0]}`);
    },
    onError: (e: Error) => toast.error("Could not change the plugin", { description: e.message }),
  });
  const plugins = data?.plugins ?? [];
  const byId = new Map(plugins.map((p) => [p.id, p]));
  const flip = (p: PluginOut, enabled: boolean) => {
    const others = enabled ? p.requires.flatMap((cap) => plugins.filter((x) => x.provides.includes(cap) && !x.enabled).map((x) => x.id)) : p.dependents;
    if (others.length) setAsk({ plugin: p, enabled, others: [...new Set(others)] });
    else toggle.mutate({ id: p.id, enabled, cascade: false });
  };
  const groups = groupPlugins(plugins, q);
  const on = plugins.filter((p) => p.enabled && p.state !== "failed" && p.state !== "blocked").length;

  return (
    <section className="space-y-3" data-testid="plugins-section">
      <div className="library-header">
        <div className="library-heading">
          <h2 className="page-title">Plugins</h2>
          <p className="page-description">Octopus is a small kernel plus plugins. Switch one off and its tools, workflow or provider disappear for the next call; a run that is already going keeps working. Channels apply at the next start. {data && <>SDK {data.sdk_version}. {on} of {plugins.length} on.</>}</p>
        </div>
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search plugins" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search plugins" />
        </div>
      </div>
      {isLoading && <p className="text-sm text-muted-foreground">Loading plugins…</p>}
      {groups.map(([slot, items]) => (
        <div key={slot} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{SLOT_LABELS[slot] ?? slot}</h3>
          <ul className="divide-y rounded-lg border bg-card">
            {items.map((p) => {
              const badge = stateBadge(p);
              const locked = p.required;
              return (
                <li key={p.id} className="flex items-start gap-3 p-3" data-testid={`plugin-${p.id}`}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{p.title}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {locked && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Part of the run loop: it has no switch"><Lock className="size-3" />Required</span>}
                      {p.applies === "restart" && !locked && <span className="text-xs text-muted-foreground">Applies at restart</span>}
                      <code className="text-xs text-muted-foreground">{p.id} · v{p.version}</code>
                    </div>
                    <p className="text-sm text-muted-foreground">{p.description}</p>
                    <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                      {p.provides.map((c) => <Badge key={`p-${c}`} variant="outline">provides {c}</Badge>)}
                      {p.requires.map((c) => <Badge key={`r-${c}`} variant="outline">needs {c}</Badge>)}
                      {p.permissions.map((c) => <Badge key={`x-${c}`} variant="secondary">{c}</Badge>)}
                    </div>
                    {p.error && <p className="text-xs text-destructive">{p.error}</p>}
                    {p.health.detail && p.health.state !== "ok" && <p className="text-xs text-warning">{p.health.detail}</p>}
                  </div>
                  <Switch checked={p.enabled && p.state !== "blocked"} disabled={locked || toggle.isPending} aria-label={`${p.title} ${p.enabled ? "on" : "off"}`}
                    className={cn(locked && "opacity-40")} onCheckedChange={(v) => flip(p, v)} />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {!isLoading && groups.length === 0 && <p className="text-sm text-muted-foreground">No plugin matches “{q}”.</p>}
      <ConfirmDialog open={!!ask} onOpenChange={(open) => { if (!open) setAsk(null); }}
        title={ask ? `${ask.enabled ? "Switch on" : "Switch off"} ${ask.plugin.title}?` : ""}
        description={ask ? (ask.enabled
          ? `${ask.plugin.title} needs ${ask.others.map((id) => byId.get(id)?.title ?? id).join(", ")}, which ${ask.others.length > 1 ? "are" : "is"} off. They will be switched on too.`
          : `${ask.others.map((id) => byId.get(id)?.title ?? id).join(", ")} ${ask.others.length > 1 ? "need" : "needs"} ${ask.plugin.title} and will be switched off with it.`) : ""}
        confirmLabel={ask?.enabled ? "Switch on all" : "Switch off all"}
        onConfirm={() => { if (ask) toggle.mutate({ id: ask.plugin.id, enabled: ask.enabled, cascade: true }); setAsk(null); }} />
    </section>
  );
}
