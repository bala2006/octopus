import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Brain, Cpu, Flag, Plug, Save, SlidersHorizontal, Trash2, User, Wrench, X, FileText } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { AGENT_COLORS, AVATARS, AVATAR_KEYS, MESSAGE_TYPE_LABEL, PERMISSIONS, TOOLS } from "@/lib/meta";
import { cn, timeAgo } from "@/lib/utils";
import { qk, useCompanyId, useMcpServers, useRuns, useWorkspaceId } from "@/hooks/queries";
import { useCanvas } from "@/stores/canvas";
import type { AgentBehavior, AgentPermission, AgentTools } from "@/types";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input, Slider, Switch, Textarea } from "@/components/ui/primitives";
import { ScrollArea, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker, type Effort } from "./EffortPicker";

export function Inspector() {
  const id = useCanvas((s) => s.inspectorId);
  const node = useCanvas((s) => s.nodes.find((n) => n.id === s.inspectorId));
  const update = useCanvas((s) => s.updateAgent);
  const close = () => useCanvas.getState().setInspector(null);
  if (!id || !node) return null;
  const d = node.data;
  const set = (p: Partial<typeof d>) => update(id, p);
  const tools = (d.tools ?? {}) as AgentTools;
  const behavior = (d.behavior ?? {}) as AgentBehavior;

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-border bg-surface animate-in slide-in-from-right-4 duration-200" aria-label="Agent inspector">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <AgentAvatar name={d.name} color={d.color} avatar={d.avatar} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{d.name}</div>
          <div className="truncate text-xs text-muted-foreground">{d.role}</div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close inspector"><X /></Button>
      </div>
      <Tabs defaultValue="profile" className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-3 py-2">
          <TabsList className="grid w-full grid-cols-7">
            {[["profile", User], ["prompt", FileText], ["model", Cpu], ["tools", Wrench], ["behavior", SlidersHorizontal], ["memory", Brain], ["activity", Activity]].map(([v, I]) => {
              const Icon = I as typeof User;
              return <TabsTrigger key={v as string} value={v as string} title={v as string} aria-label={v as string}><Icon /></TabsTrigger>;
            })}
          </TabsList>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <TabsContent value="profile" className="space-y-4">
              <Heading>Profile</Heading>
              <Field label="Name"><Input value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
              <Field label="Role / title"><Input value={d.role ?? ""} onChange={(e) => set({ role: e.target.value })} /></Field>
              <Field label="Description"><Textarea value={d.description ?? ""} onChange={(e) => set({ description: e.target.value })} className="min-h-[60px]" /></Field>
              <Field label="Color">
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_COLORS.map((c) => (
                    <button key={c} onClick={() => set({ color: c })} aria-label={`Color ${c}`} className={cn("h-6 w-6 rounded-full transition-transform hover:scale-110", d.color === c && "ring-2 ring-foreground ring-offset-2 ring-offset-surface")} style={{ background: c }} />
                  ))}
                </div>
              </Field>
              <Field label="Avatar">
                <div className="grid grid-cols-9 gap-1">
                  {AVATAR_KEYS.map((k) => {
                    const I = AVATARS[k];
                    return (
                      <button key={k} onClick={() => set({ avatar: k })} aria-label={k} className={cn("flex h-8 items-center justify-center rounded-md border transition", d.avatar === k ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent")}>
                        <I className="h-4 w-4" />
                      </button>
                    );
                  })}
                </div>
              </Field>
              <label className="flex items-center justify-between rounded-lg border border-border p-3">
                <span><span className="flex items-center gap-1.5 text-sm font-medium"><Flag className="h-3.5 w-3.5 text-primary" />Entry agent</span><span className="text-xs text-muted-foreground">Receives the goal when the company runs</span></span>
                <Switch checked={!!d.is_entry} onCheckedChange={(v) => update(id, { is_entry: v }, { history: true })} />
              </label>
            </TabsContent>

            <TabsContent value="prompt" className="space-y-3">
              <Heading>System prompt</Heading>
              <p className="text-xs text-muted-foreground">Variables: <code>{"{{company_name}}"}</code> <code>{"{{goal}}"}</code> <code>{"{{team}}"}</code> <code>{"{{agent_name}}"}</code> <code>{"{{role}}"}</code>. The runtime appends the team roster, channels, blackboard and action schema automatically.</p>
              <Textarea value={d.system_prompt ?? ""} onChange={(e) => set({ system_prompt: e.target.value })} className="min-h-[420px] font-mono text-[11.5px] leading-relaxed" spellCheck={false} />
              <div className="text-right text-[11px] text-muted-foreground">{(d.system_prompt ?? "").length.toLocaleString()} chars</div>
            </TabsContent>

            <TabsContent value="model" className="space-y-4">
              <Heading>Model</Heading>
              <ModelPicker provider={d.provider ?? "mock"} model={d.model ?? ""} onChange={(p, m) => set({ provider: p, model: m })} />
              <Field label="Reasoning effort" hint="How long the model thinks before answering. Higher = better on hard work, more tokens and time.">
                <EffortPicker value={(behavior.reasoning_effort ?? "default") as Effort} onChange={(v) => set({ behavior: { ...behavior, reasoning_effort: v } })} />
              </Field>
              <Field label={`Temperature: ${(d.temperature ?? 0.4).toFixed(2)}`}>
                <Slider min={0} max={2} step={0.05} value={[d.temperature ?? 0.4]} onValueChange={([v]) => set({ temperature: v })} aria-label="Temperature" />
              </Field>
              <Field label="Max output tokens"><Input type="number" min={64} max={64000} value={d.max_tokens ?? 8192} onChange={(e) => set({ max_tokens: Math.max(64, +e.target.value || 64) })} /></Field>
            </TabsContent>

            <TabsContent value="tools" className="space-y-4">
              <Heading>Tools & permissions</Heading>
              <div className="space-y-1.5">
                {TOOLS.map((t) => (
                  <label key={t.key} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-2.5 transition hover:bg-accent/30">
                    <t.icon className={cn("h-4 w-4", t.danger ? "text-warning" : "text-muted-foreground")} />
                    <span className="flex-1"><span className="block text-sm">{t.label}</span><span className="block text-[11px] text-muted-foreground">{t.hint}</span></span>
                    <Switch checked={!!(tools as Record<string, unknown>)[t.key]} onCheckedChange={(v) => set({ tools: { ...tools, [t.key]: v } })} />
                  </label>
                ))}
              </div>
              <McpGrants tools={tools} onChange={(ids) => set({ tools: { ...tools, mcp_servers: ids } })} />
              <Field label="Permission level" hint="An agent can only be more restrictive than the run's level.">
                <Select value={(d.permission_level as string) ?? "inherit"} onValueChange={(v) => update(id, { permission_level: v as AgentPermission }, { history: true })}
                  options={[{ value: "inherit", label: "Inherit from run" }, ...Object.entries(PERMISSIONS).map(([k, p]) => ({ value: k, label: p.label, hint: p.description }))]} />
              </Field>
            </TabsContent>

            <TabsContent value="behavior" className="space-y-5">
              <Heading>Behavior</Heading>
              {(["assertiveness", "creativity", "strictness"] as const).map((k) => (
                <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)}: ${Math.round((behavior[k] ?? 0.5) * 100)}%`}>
                  <Slider min={0} max={1} step={0.05} value={[behavior[k] ?? 0.5]} onValueChange={([v]) => set({ behavior: { ...behavior, [k]: v } })} aria-label={k} />
                </Field>
              ))}
              <Field label="Debate style">
                <Select value={behavior.debate_style ?? "balanced"} onValueChange={(v) => set({ behavior: { ...behavior, debate_style: v as AgentBehavior["debate_style"] } })}
                  options={[{ value: "agreeable", label: "Agreeable", hint: "Seeks common ground quickly" }, { value: "balanced", label: "Balanced", hint: "Judges on merit" }, { value: "devils_advocate", label: "Devil's advocate", hint: "Stress-tests every idea" }]} />
              </Field>
              <Field label="Max autonomous turns" hint="Hard cap on how many turns this agent may take in one run.">
                <Input type="number" min={1} max={200} value={behavior.max_autonomous_turns ?? 12} onChange={(e) => set({ behavior: { ...behavior, max_autonomous_turns: Math.min(200, Math.max(1, +e.target.value || 1)) } })} />
              </Field>
            </TabsContent>

            <TabsContent value="memory"><MemoryTab agentId={id} /></TabsContent>
            <TabsContent value="activity"><ActivityTab agentId={id} /></TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </aside>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function McpGrants({ tools, onChange }: { tools: AgentTools; onChange: (ids: string[]) => void }) {
  const { data } = useMcpServers();
  const ids = tools.mcp_servers ?? [];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Plug className="h-3.5 w-3.5" />MCP servers</div>
      {!data?.length && <p className="text-xs text-muted-foreground">No MCP servers registered. Add them in Settings.</p>}
      {data?.map((s) => (
        <label key={s.id} className="flex items-center gap-3 rounded-lg border border-border p-2.5">
          <Plug className="h-4 w-4 text-olive" />
          <span className="flex-1"><span className="block text-sm">{s.name}</span><span className="block truncate text-[11px] text-muted-foreground">{(s.tools ?? []).map((t) => t.name).join(", ") || s.last_error || "no tools"}</span></span>
          <Switch checked={ids.includes(s.id)} disabled={!s.enabled} onCheckedChange={(v) => onChange(v ? [...ids, s.id] : ids.filter((x) => x !== s.id))} />
        </label>
      ))}
    </div>
  );
}

function MemoryTab({ agentId }: { agentId: string }) {
  const w = useWorkspaceId();
  const qc = useQueryClient();
  const [key, setKey] = React.useState("");
  const [value, setValue] = React.useState("");
  const q = useQuery({ queryKey: qk.memory(w, agentId), retry: false, queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/agents/{agent_id}/memory", { params: { path: { workspace_id: w, agent_id: agentId } } })) });
  const put = useMutation({
    mutationFn: () => unwrap(api.PUT("/api/v1/w/{workspace_id}/agents/{agent_id}/memory", { params: { path: { workspace_id: w, agent_id: agentId } }, body: { key, value } })),
    onSuccess: () => { setKey(""); setValue(""); qc.invalidateQueries({ queryKey: qk.memory(w, agentId) }); toast.success("Memory saved"); },
  });
  const del = useMutation({
    mutationFn: (k: string) => unwrap(api.DELETE("/api/v1/w/{workspace_id}/agents/{agent_id}/memory/{key}", { params: { path: { workspace_id: w, agent_id: agentId, key: k } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.memory(w, agentId) }),
  });
  return (
    <div className="space-y-4">
      <Heading>Long-term memory</Heading>
      <p className="text-xs text-muted-foreground">Persistent notes injected into every prompt. Agents add to it with the <code>remember</code> action. Short-term memory is the conversation itself (with rolling summaries).</p>
      {q.isError ? <p className="text-xs text-muted-foreground">Save the canvas first to use memory.</p> : (
        <ul className="space-y-1.5">
          {q.data?.map((m) => (
            <li key={m.id} className="group rounded-lg border border-border p-2.5 text-xs">
              <div className="flex items-center justify-between"><span className="font-mono font-medium">{m.key}</span>
                <button onClick={() => del.mutate(m.key)} className="opacity-0 transition group-hover:opacity-100" aria-label={`Delete ${m.key}`}><Trash2 className="h-3.5 w-3.5 text-destructive" /></button></div>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{m.value}</p>
              <p className="mt-1 text-[10px] text-muted-foreground/70">{timeAgo(m.updated_at)}</p>
            </li>
          ))}
          {q.data?.length === 0 && <li className="text-xs text-muted-foreground">No notes yet.</li>}
        </ul>
      )}
      <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
        <Input placeholder="key (e.g. coding_style)" value={key} onChange={(e) => setKey(e.target.value)} className="h-8 font-mono text-xs" />
        <Textarea placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} className="min-h-[56px] text-xs" />
        <Button size="sm" disabled={!key.trim()} loading={put.isPending} onClick={() => put.mutate()}><Save />Save note</Button>
      </div>
    </div>
  );
}

function ActivityTab({ agentId }: { agentId: string }) {
  const w = useWorkspaceId();
  const { companyId } = useCompanyId();
  const runs = useRuns(w, companyId);
  const latest = runs.data?.[0];
  const msgs = useQuery({
    queryKey: ["run-msgs", w, latest?.id], enabled: !!latest,
    queryFn: () => unwrap(api.GET("/api/v1/w/{workspace_id}/runs/{run_id}/messages", { params: { path: { workspace_id: w, run_id: latest!.id } } })),
  });
  const mine = (msgs.data ?? []).filter((m) => m.from_agent_id === agentId || m.to_agent_id === agentId).slice(-40).reverse();
  if (!latest) return <EmptyState icon={Activity} title="No runs yet" description="Run the company to see this agent's messages and tool calls." />;
  return (
    <div className="space-y-3">
      <Heading>Latest run activity</Heading>
      <p className="truncate text-xs text-muted-foreground">“{latest.goal}” · {timeAgo(latest.created_at)}</p>
      <ol className="space-y-1.5">
        {mine.map((m) => (
          <li key={m.id} className="rounded-lg border border-border p-2 text-xs animate-fade-up">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>{m.from_agent_id === agentId ? "sent" : "received"} · {MESSAGE_TYPE_LABEL[m.type] ?? m.type}</span><span>turn {m.turn_no}</span>
            </div>
            <p className="mt-1 line-clamp-3 text-foreground/90">{m.content}</p>
          </li>
        ))}
        {!mine.length && <li className="text-xs text-muted-foreground">This agent had no messages in the latest run.</li>}
      </ol>
    </div>
  );
}
