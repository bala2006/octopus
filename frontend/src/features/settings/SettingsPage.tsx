import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, ChevronDown, Cloud, FolderOpen, KeyRound, Moon, Palette, Plug, Plus, RefreshCw, Server, ShieldCheck, Sparkles, Sun, Trash2, Wifi, XCircle, Zap,
} from "lucide-react";
import { api, unwrap } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { qk, useMcpServers, useSettings, useWorkspace, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { McpServerOut, PermissionLevel, ProviderInfo, ProviderKeyOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Select, Tip } from "@/components/ui/overlays";
import { PermissionPicker } from "@/features/workspaces/DirectoryPicker";

const SECTIONS = [["providers", "Model providers", Cloud], ["mcp", "MCP servers", Plug], ["project", "Project", FolderOpen], ["appearance", "Appearance", Palette]] as const;

export default function SettingsPage() {
  const [section, setSection] = React.useState<string>(() => (location.hash.slice(1) || "providers"));
  React.useEffect(() => { history.replaceState(null, "", `#${section}`); }, [section]);
  return (
    <div className="flex h-full">
      <nav className="w-52 shrink-0 space-y-0.5 border-r border-border bg-surface p-3" aria-label="Settings sections">
        {SECTIONS.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setSection(k)} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition hover:bg-accent", section === k && "bg-accent font-medium")}>
            <Icon className="h-4 w-4 text-muted-foreground" />{label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6 animate-fade-up" key={section}>
          {section === "providers" && <Providers />}
          {section === "mcp" && <McpServers />}
          {section === "project" && <ProjectSettings />}
          {section === "appearance" && <Appearance />}
        </div>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div><h2 className="text-base font-semibold">{title}</h2>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- providers
function Providers() {
  const { data, isLoading } = useSettings();
  const keys = Object.fromEntries((data?.keys ?? []).map((k) => [k.provider, k]));
  const info = Object.fromEntries((data?.providers ?? []).map((p) => [p.provider, p]));
  const [showOthers, setShowOthers] = React.useState(false);
  if (isLoading) return <div className="space-y-3">{[0, 1].map((i) => <div key={i} className="skeleton h-40" />)}</div>;
  return (
    <>
      <Section title="Model providers" description="Keys are encrypted at rest in your local Octopus registry and never sent back to the browser.">
        <div className={cn("flex items-center gap-3 rounded-xl border p-3", data?.demo_mode ? "border-primary/30 bg-primary/5" : "border-border")}>
          <Sparkles className="h-4 w-4 text-primary" />
          <div className="flex-1 text-sm"><span className="font-medium">Demo Mode {data?.demo_mode ? "is on" : "is off"}.</span>{" "}
            <span className="text-muted-foreground">Agents whose provider isn't configured fall back to the offline scripted mock. Toggle per run in the Run dialog.</span></div>
        </div>
        <AzureCard provider="azure" title="Azure OpenAI" subtitle="Deployments on an Azure OpenAI / Foundry resource: azure/<deployment>" info={info.azure} saved={keys.azure}
          endpointHint="https://<resource>.openai.azure.com" showVersion />
        <AzureCard provider="azure_ai" title="Azure AI Foundry models" subtitle="Foundry model inference endpoint (DeepSeek, Llama, Phi, Mistral, Claude…): azure_ai/<model>" info={info.azure_ai} saved={keys.azure_ai}
          endpointHint="https://<resource>.services.ai.azure.com/models" />
      </Section>
      <div>
        <button onClick={() => setShowOthers(!showOthers)} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("h-4 w-4 transition-transform", showOthers && "rotate-180")} />Other providers (OpenAI, Anthropic, Gemini, Ollama…)
        </button>
        {showOthers && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 animate-fade-up">
            {(data?.providers ?? []).filter((p) => !["mock", "azure", "azure_ai"].includes(p.provider)).map((p) => <SimpleProvider key={p.provider} info={p} saved={keys[p.provider]} />)}
          </div>
        )}
      </div>
    </>
  );
}

function useProviderSave(provider: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { api_key: string; base_url: string; options: { api_version?: string; auth?: "key" | "entra"; deployments?: string[]; reasoning_models?: string[] } }) =>
      unwrap(api.PUT("/api/v1/settings/providers", { body: { provider: provider as "azure", api_key: body.api_key, base_url: body.base_url,
        options: { api_version: body.options.api_version ?? "", auth: body.options.auth ?? "key", deployments: body.options.deployments ?? [], reasoning_models: body.options.reasoning_models ?? [] } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.settings }); toast.success("Saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
}

function TestButton({ provider, model, disabled }: { provider: string; model: string; disabled?: boolean }) {
  const [res, setRes] = React.useState<{ ok: boolean; detail: string; latency_ms?: number } | null>(null);
  const test = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/settings/providers/test", { body: { provider, model } })),
    onMutate: () => setRes(null), onSuccess: setRes,
  });
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Button size="sm" variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={disabled || !model}><Wifi />Test connection</Button>
      {res && (
        <span className={cn("flex min-w-0 items-center gap-1 text-xs animate-in fade-in-0", res.ok ? "text-success" : "text-destructive")}>
          {res.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate" title={res.detail}>{res.detail}</span>{res.latency_ms ? <span className="shrink-0 text-muted-foreground">· {res.latency_ms}ms</span> : null}
        </span>
      )}
    </div>
  );
}

function AzureCard({ provider, title, subtitle, info, saved, endpointHint, showVersion }: {
  provider: "azure" | "azure_ai"; title: string; subtitle: string; info?: ProviderInfo; saved?: ProviderKeyOut; endpointHint: string; showVersion?: boolean;
}) {
  const [endpoint, setEndpoint] = React.useState(saved?.base_url ?? "");
  const [key, setKey] = React.useState("");
  const [auth, setAuth] = React.useState<"key" | "entra">((saved?.options.auth as "key" | "entra") ?? "key");
  const [version, setVersion] = React.useState(saved?.options.api_version || "2024-10-21");
  const [deps, setDeps] = React.useState((saved?.options.deployments ?? []).join("\n"));
  const [reasoning, setReasoning] = React.useState((saved?.options.reasoning_models ?? []).join(", "));
  React.useEffect(() => {
    if (!saved) return;
    setEndpoint(saved.base_url); setAuth((saved.options.auth as "key" | "entra") ?? "key"); setVersion(saved.options.api_version || "2024-10-21");
    setDeps((saved.options.deployments ?? []).join("\n")); setReasoning((saved.options.reasoning_models ?? []).join(", "));
  }, [saved]);
  const save = useProviderSave(provider);
  const depList = deps.split(/[\n,]/).map((d) => d.trim()).filter(Boolean);
  const [testModel, setTestModel] = React.useState(depList[0] ?? "");
  React.useEffect(() => { if (!testModel && depList[0]) setTestModel(depList[0]); }, [depList, testModel]);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/api/v1/settings/providers/{provider}", { params: { path: { provider } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.settings }); setKey(""); setEndpoint(""); toast.success("Removed"); },
  });
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-blue-700 text-white"><Cloud className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{title}</div><div className="truncate text-xs text-muted-foreground">{subtitle}</div></div>
        {info?.configured ? <Badge variant="success"><CheckCircle2 className="h-3 w-3" />Configured</Badge> : <Badge variant="outline">Not configured</Badge>}
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Endpoint" hint={endpointHint}><Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={endpointHint} className="font-mono text-xs" /></Field>
        {showVersion ? <Field label="API version"><Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono text-xs" /></Field> : <div />}
        <Field label="Authentication">
          <Select value={auth} onValueChange={(v) => setAuth(v as "key" | "entra")} options={[
            { value: "key", label: "API key", hint: "Keys and Endpoint page of the resource" },
            { value: "entra", label: "Microsoft Entra ID", hint: "Uses az login / managed identity / env credentials" }]} />
        </Field>
        {auth === "key" ? (
          <Field label="API key" hint={saved?.masked_key ? `Stored: ${saved.masked_key} (leave empty to keep)` : "Stored encrypted"}>
            <div className="relative"><KeyRound className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={saved?.masked_key || "••••••••"} className="pl-8 font-mono text-xs" autoComplete="off" /></div>
          </Field>
        ) : <p className="self-end rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">Run <code>az login</code> on this machine. The identity needs the <b>Cognitive Services OpenAI User</b> role.</p>}
        <Field label={provider === "azure" ? "Deployment names" : "Model names"} hint="One per line. These appear in every agent's model picker.">
          <Textarea value={deps} onChange={(e) => setDeps(e.target.value)} placeholder={provider === "azure" ? "gpt-4.1\ngpt-4.1-mini\no4-mini" : "DeepSeek-R1\nPhi-4"} className="min-h-[76px] font-mono text-xs" />
        </Field>
        <Field label="Reasoning deployments" hint="Comma-separated. Sent with max_completion_tokens and no temperature (o-series, gpt-5).">
          <Input value={reasoning} onChange={(e) => setReasoning(e.target.value)} placeholder="o4-mini, gpt-5" className="font-mono text-xs" />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background/40 px-4 py-2.5">
        <Button size="sm" loading={save.isPending} disabled={!endpoint} onClick={() => save.mutate({ api_key: key, base_url: endpoint, options: { api_version: version, auth, deployments: depList, reasoning_models: reasoning.split(",").map((s) => s.trim()).filter(Boolean) } })}>Save</Button>
        {depList.length > 1 && <Select value={testModel} onValueChange={setTestModel} options={depList.map((d) => ({ value: d, label: d }))} className="h-8 w-40 text-xs" ariaLabel="Model to test" />}
        <TestButton provider={provider} model={testModel || depList[0] || ""} disabled={!info?.configured} />
        {saved && <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => remove.mutate()}><Trash2 />Remove</Button>}
      </div>
    </div>
  );
}

function SimpleProvider({ info, saved }: { info: ProviderInfo; saved?: ProviderKeyOut }) {
  const [key, setKey] = React.useState("");
  const [base, setBase] = React.useState(saved?.base_url ?? "");
  const save = useProviderSave(info.provider);
  return (
    <div className="space-y-2.5 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center justify-between"><span className="text-sm font-medium">{info.label}</span>
        {info.configured ? <Badge variant="success">Ready</Badge> : <Badge variant="outline">Off</Badge>}</div>
      {info.needs_key && <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={saved?.masked_key || "API key"} className="h-8 font-mono text-xs" autoComplete="off" />}
      {info.provider === "ollama" && <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="http://localhost:11434" className="h-8 font-mono text-xs" />}
      <div className="flex items-center gap-2">
        <Button size="xs" onClick={() => save.mutate({ api_key: key, base_url: base, options: {} })} loading={save.isPending}>Save</Button>
        <TestButton provider={info.provider} model={info.models[0] ?? ""} disabled={!info.configured} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- MCP
function McpServers() {
  const { data, isLoading } = useMcpServers();
  const [editing, setEditing] = React.useState<McpServerOut | "new" | null>(null);
  const [del, setDel] = React.useState<McpServerOut | null>(null);
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/api/v1/mcp-servers/{server_id}/refresh", { params: { path: { server_id: id } } })),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: qk.mcp }); s.last_error ? toast.error(`${s.name}: ${s.last_error}`) : toast.success(`${s.name}: ${(s.tools ?? []).length} tools`); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/api/v1/mcp-servers/{server_id}", { params: { path: { server_id: id } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.mcp }); toast.success("MCP server removed"); },
  });
  return (
    <Section title="MCP servers" description="Register Model Context Protocol servers, then grant them to individual agents from the canvas. Calls respect the run's permission level.">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEditing("new")}><Plus />Add MCP server</Button></div>
      {isLoading ? <div className="skeleton h-24" /> : !data?.length ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <Plug className="mx-auto mb-2 h-5 w-5" />No MCP servers yet. Example: <code className="rounded bg-muted px-1">npx -y @modelcontextprotocol/server-everything</code>
        </div>
      ) : (
        <div className="space-y-2">
          {data.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex items-center gap-3">
                <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", s.last_error ? "bg-destructive/15 text-destructive" : "bg-pink-500/15 text-pink-400")}><Server className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">{s.name}<Badge variant="outline">{s.transport}</Badge>{!s.enabled && <Badge variant="secondary">disabled</Badge>}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`}</div>
                </div>
                <Tip content="Reconnect and list tools"><Button size="icon-sm" variant="ghost" onClick={() => refresh.mutate(s.id)} aria-label="Refresh tools"><RefreshCw className={cn(refresh.isPending && refresh.variables === s.id && "animate-spin")} /></Button></Tip>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>
                <Button size="icon-sm" variant="ghost" className="text-destructive" onClick={() => setDel(s)} aria-label="Delete"><Trash2 /></Button>
              </div>
              {s.last_error ? <p className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{s.last_error}</p> : (
                <div className="mt-2 flex flex-wrap gap-1">{(s.tools ?? []).map((t) => <Tip key={t.name} content={t.description}><span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[10.5px]">{t.name}</span></Tip>)}
                  <span className="text-[10.5px] text-muted-foreground">· updated {timeAgo(s.updated_at)}</span></div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && <McpDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Remove ${del?.name}?`} destructive confirmLabel="Remove"
        description="Agents granted this server lose access on their next run." onConfirm={() => del && remove.mutate(del.id)} />
    </Section>
  );
}

function McpDialog({ server, onClose }: { server: McpServerOut | null; onClose: () => void }) {
  const [name, setName] = React.useState(server?.name ?? "");
  const [transport, setTransport] = React.useState<"stdio" | "http">((server?.transport as "stdio" | "http") ?? "stdio");
  const [command, setCommand] = React.useState(server?.command ?? "npx");
  const [args, setArgs] = React.useState(server?.args.join(" ") ?? "-y @modelcontextprotocol/server-everything");
  const [url, setUrl] = React.useState(server?.url ?? "");
  const [env, setEnv] = React.useState("");
  const [enabled, setEnabled] = React.useState(server?.enabled ?? true);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => {
      const envObj = Object.fromEntries(env.split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
      const body = { name: name.trim(), transport, command: command.trim(), args: args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [], url: url.trim(), env: envObj, enabled };
      return server ? unwrap(api.PUT("/api/v1/mcp-servers/{server_id}", { params: { path: { server_id: server.id } }, body }))
        : unwrap(api.POST("/api/v1/mcp-servers", { body }));
    },
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.mcp });
      if (s.last_error) toast.warning(`Saved, but connecting failed`, { description: s.last_error });
      else toast.success(`${s.name} connected`, { description: `${(s.tools ?? []).length} tools discovered` });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{server ? `Edit ${server.name}` : "Add MCP server"}</DialogTitle>
          <DialogDescription>Octopus connects, lists the tools, and lets granted agents call them with <code>mcp_call</code>.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" /></Field>
            <Field label="Transport"><Select value={transport} onValueChange={(v) => setTransport(v as "stdio" | "http")} options={[{ value: "stdio", label: "stdio (local)" }, { value: "http", label: "HTTP" }]} /></Field>
          </div>
          {transport === "stdio" ? (
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <Field label="Command"><Input value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono text-xs" /></Field>
              <Field label="Arguments"><Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-xs" /></Field>
            </div>
          ) : <Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3001/mcp" className="font-mono text-xs" /></Field>}
          <Field label={transport === "http" ? "Headers (KEY=value per line, encrypted)" : "Environment (KEY=value per line, encrypted)"}
            hint={server?.env_keys.length ? `Stored keys: ${server.env_keys.join(", ")}. Leave empty to keep them.` : undefined}>
            <Textarea value={env} onChange={(e) => setEnv(e.target.value)} className="min-h-[60px] font-mono text-xs" placeholder={transport === "http" ? "Authorization=Bearer …" : "GITHUB_TOKEN=…"} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} />Enabled</label>
        </div>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}><Zap />Save & connect</Button></div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- project / appearance
function ProjectSettings() {
  const w = useWorkspaceId();
  const { data } = useWorkspace(w);
  const qc = useQueryClient();
  const [name, setName] = React.useState("");
  React.useEffect(() => { if (data) setName(data.name); }, [data]);
  const patch = useMutation({
    mutationFn: (body: { name?: string; default_permission?: PermissionLevel }) => unwrap(api.PATCH("/api/v1/workspaces/{workspace_id}", { params: { path: { workspace_id: w } }, body })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.workspace(w) }); qc.invalidateQueries({ queryKey: qk.workspaces }); toast.success("Project updated"); },
  });
  if (!data) return <div className="skeleton h-40" />;
  return (
    <Section title="Project" description="Agents are sandboxed to this directory. All Octopus data for it lives in its .octopus folder.">
      <div className="space-y-4 rounded-xl border border-border bg-surface p-4">
        <Field label="Name"><div className="flex gap-2"><Input value={name} onChange={(e) => setName(e.target.value)} /><Button variant="secondary" onClick={() => patch.mutate({ name })} disabled={name === data.name}>Rename</Button></div></Field>
        <Field label="Directory"><code className="block rounded-md bg-muted px-2.5 py-2 font-mono text-xs">{data.path}</code></Field>
        <Field label="Data folder" hint="Contains octopus.db (companies, agents, chats, runs, events, artifact history), plans/ and exports/. Git-ignored by default.">
          <code className="block rounded-md bg-muted px-2.5 py-2 font-mono text-xs">{data.path}/.octopus/</code>
        </Field>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-medium"><ShieldCheck className="h-4 w-4 text-primary" />Default permission level for new runs</div>
        <PermissionPicker value={data.default_permission as PermissionLevel} onChange={(v) => patch.mutate({ default_permission: v })} />
      </div>
    </Section>
  );
}

function Appearance() {
  const { theme, setTheme } = useApp();
  return (
    <Section title="Appearance">
      <div className="grid grid-cols-2 gap-3">
        {(["dark", "light"] as const).map((t) => (
          <button key={t} onClick={() => setTheme(t)} className={cn("rounded-xl border p-4 text-left transition hover:border-primary/50", theme === t ? "border-primary bg-primary/5" : "border-border")}>
            <div className={cn("mb-3 h-16 rounded-lg border", t === "dark" ? "border-slate-700 bg-[#0e1220]" : "border-slate-200 bg-white")} />
            <span className="flex items-center gap-1.5 text-sm font-medium">{t === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}{t === "dark" ? "Dark" : "Light"}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}
