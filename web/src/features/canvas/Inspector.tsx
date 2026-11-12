import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Activity, Brain, Cpu, Flag, Plug, Save, Trash2, User, Wrench, X, FileText } from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { AGENT_COLORS, AVATARS, AVATAR_KEYS, MESSAGE_TYPE_LABEL, TOOLS } from "@/lib/meta";
import { cn, timeAgo } from "@/lib/utils";
import { qk, useCompanyId, useMcpServers, useRoleTemplates, useRuns, useWorkspaceId } from "@/hooks/queries";
import { Link } from "react-router-dom";
import { Combobox } from "@/components/ui/combobox";
import { applyRole, isLinked, roleOptions } from "./roleHelpers";
import { useCanvas } from "@/stores/canvas";
import type { AgentBehavior, AgentTools } from "@/types";
import { AgentAvatar, EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import { ScrollArea, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker, type Effort } from "./EffortPicker";

export function Inspector() {
  const id = useCanvas((s) => s.inspectorId);
  const node = useCanvas((s) => s.nodes.find((n) => n.id === s.inspectorId));
  const update = useCanvas((s) => s.updateAgent);
  const { data: roles = [] } = useRoleTemplates();
  const w = useWorkspaceId();
  const close = () => useCanvas.getState().setInspector(null);
  if (!id || !node) return null;
  const d = node.data;
  const set = (p: Partial<typeof d>) => update(id, p);
  const tools = (d.tools ?? {}) as AgentTools;
  const behavior = (d.behavior ?? {}) as AgentBehavior;
  const role = roles.find((r) => r.key === behavior.template_key);
  const linked = isLinked(d, roles);

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
          <TabsList className="grid w-full grid-cols-6">
            {[["profile", User], ["prompt", FileText], ["model", Cpu], ["tools", Wrench], ["memory", Brain], ["activity", Activity]].map(([v, I]) => {
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
              <Field label="Role" hint="Brings the prompt, look and default tools (edit roles in Settings → Roles).">
                <Combobox value={behavior.template_key ?? ""} options={roleOptions(roles)} ariaLabel="Role" placeholder="Pick a role"
                  onChange={(k) => { const r = roles.find((x) => x.key === k); if (r) update(id, applyRole(d, r), { history: true }); }} />
              </Field>
              <Field label="Title" hint="How teammates see this agent; defaults to the role's name."><Input value={d.role ?? ""} onChange={(e) => set({ role: e.target.value })} /></Field>
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
                <span><span className="flex items-center gap-1.5 text-sm font-medium"><Flag className="h-3.5 w-3.5 text-primary" />Team lead</span><span className="text-xs text-muted-foreground">Leads the team: plans every request, hires, and reports back to you</span></span>
                <Switch checked={!!d.is_entry} onCheckedChange={(v) => update(id, { is_entry: v }, { history: true })} />
              </label>
            </TabsContent>

            <TabsContent value="prompt" className="space-y-3">
              <Heading>System prompt</Heading>
              {linked && role ? (
                <>
                  <p className="text-xs text-muted-foreground">This agent uses the <b>{role.role}</b> role's prompt, so changes to the role in{" "}
                    <Link className="text-primary hover:underline" to={`/w/${w}/settings#roles`}>Settings → Roles</Link> apply here too.</p>
                  <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground" data-testid="role-prompt-preview">{role.system_prompt}</pre>
                  <Button size="sm" variant="outline" onClick={() => update(id, { system_prompt: role.system_prompt, behavior: { ...behavior, prompt_linked: false } }, { history: true })}>
                    Use a prompt of its own instead
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">This agent has a prompt of its own. Variables: <code>{"{{agent_name}}"}</code> <code>{"{{role}}"}</code> <code>{"{{company_name}}"}</code> <code>{"{{goal}}"}</code>. Octopus adds the team, the project overview, the shared engineering standards, matching skills and the agent's notes.</p>
                  <Textarea value={d.system_prompt ?? ""} onChange={(e) => set({ system_prompt: e.target.value, behavior: { ...behavior, prompt_linked: false } })} className="min-h-[340px] font-mono text-[11.5px] leading-relaxed" spellCheck={false} aria-label="System prompt" />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    {role ? <button className="text-primary hover:underline" onClick={() => update(id, applyRole(d, role), { history: true })}>Use the {role.role} role prompt</button> : <span />}
                    <span>{(d.system_prompt ?? "").length.toLocaleString()} chars</span>
                  </div>
                </>
              )}
              <Field label="Additional instructions" hint="Added after the prompt, for this agent only (e.g. “Use pytest”, “You own the frontend”).">
                <Textarea value={behavior.extra_instructions ?? ""} onChange={(e) => set({ behavior: { ...behavior, extra_instructions: e.target.value } })} className="min-h-[90px] text-xs" aria-label="Additional instructions" />
              </Field>
            </TabsContent>

            <TabsContent value="model" className="space-y-4">
              <Heading>Model</Heading>
              <ModelPicker provider={d.provider ?? "azure"} model={d.model ?? ""} onChange={(p, m) => set({ provider: p, model: m })} />
              <Field label="Reasoning effort" hint="How long the model thinks before answering. Higher = better on hard work, more tokens and time.">
                <EffortPicker value={(behavior.reasoning_effort ?? "default") as Effort} onChange={(v) => set({ behavior: { ...behavior, reasoning_effort: v } })} />
              </Field>
            </TabsContent>

            <TabsContent value="tools" className="space-y-4">
              <Heading>Tools</Heading>
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
      <p className="text-xs text-muted-foreground">Notes this agent sees on every task. Agents add their own with the <code>remember</code> tool; you can add or delete notes here.</p>
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
  if (!latest) return <EmptyState icon={Activity} title="No team activity yet" description="Start a conversation to see this agent's messages and tool calls." />;
  return (
    <div className="space-y-3">
      <Heading>Latest team activity</Heading>
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
        {!mine.length && <li className="text-xs text-muted-foreground">This agent had no messages in the latest conversation.</li>}
      </ol>
    </div>
  );
}
