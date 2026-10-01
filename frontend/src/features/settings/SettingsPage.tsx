import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CheckCircle2, ChevronDown, Cloud, FolderOpen, KeyRound, Moon, Palette, Plug, Plus, RefreshCw, Server, ShieldCheck, Sparkles, Sun, Trash2, Wifi, XCircle, Zap,
  LayoutTemplate, Download, Upload, Pencil, Globe,
} from "lucide-react";
import { download } from "@/lib/utils";
import { CURRENCIES, formatMoney, useFxRate } from "@/lib/money";
import { useTemplates } from "@/hooks/queries";
import { DepartmentChips } from "@/features/workspaces/NewCompanyDialog";
import { api, unwrap } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { qk, useMcpServers, useSettings, useWorkspace, useWorkspaceId } from "@/hooks/queries";
import { useApp } from "@/stores/app";
import type { McpServerOut, PermissionLevel, ProviderInfo, ProviderKeyOut } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Switch, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Select, Tip } from "@/components/ui/overlays";
import { PermissionPicker } from "@/features/workspaces/DirectoryPicker";

// The key is the URL hash (settings#appearance deep links must keep working); the label is what the nav and the panel show.
export const SECTIONS = [["providers", "Model", Cloud], ["mcp", "MCP servers", Plug], ["templates", "Templates", LayoutTemplate], ["project", "Project", FolderOpen], ["appearance", "Preferences", Palette]] as const;
/** The section for a URL hash; unknown or empty hashes fall back to the first section instead of rendering nothing. */
export const sectionFromHash = (hash: string): string => { const h = hash.replace(/^#/, ""); return SECTIONS.some(([k]) => k === h) ? h : SECTIONS[0][0]; };

export default function SettingsPage() {
  const [section, setSection] = React.useState<string>(() => sectionFromHash(location.hash));
  React.useEffect(() => { history.replaceState(null, "", `#${section}`); }, [section]);
  React.useEffect(() => { // in-app links like settings#providers while Settings is already open
    const onHash = () => { const h = location.hash.slice(1); if (h && SECTIONS.some(([k]) => k === h)) setSection(h); };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return (
    <div className="flex h-full">
      <nav className="w-52 shrink-0 space-y-0.5 overflow-y-auto border-r border-border bg-surface p-3" aria-label="Settings sections">
        {SECTIONS.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setSection(k)} title={label} aria-current={section === k ? "page" : undefined}
            className={cn("flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-sm transition hover:bg-accent", section === k && "bg-accent font-medium")}>
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate">{label}</span>
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6 animate-fade-up" key={section}>
          {section === "providers" && <Providers />}
          {section === "mcp" && <McpServers />}
          {section === "templates" && <TemplatesSection />}
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
  if (isLoading) return <div className="skeleton h-72" />;
  return (
    <Section title="Model" description="Agents run on your Azure OpenAI deployment. The key is encrypted on this machine and never sent back to the browser.">
      {!info.azure?.configured && (
        <div className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
          <Sparkles className="h-4 w-4 text-primary" />
          <div className="flex-1 text-sm"><span className="font-medium">Demo Mode until Azure is connected.</span>{" "}
            <span className="text-muted-foreground">Agents use an offline scripted model, so you can try everything for free.</span></div>
        </div>
      )}
      <AzureCard provider="azure" title="Azure OpenAI" subtitle="gpt-6-luna on your Azure OpenAI / Foundry resource (v1 Responses API)" info={info.azure} saved={keys.azure}
        endpointHint="https://<resource>.services.ai.azure.com/openai/v1/responses" />
    </Section>
  );
}

function useProviderSave(provider: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { api_key: string; base_url: string; options: { api_version?: string; api_style?: "auto" | "responses" | "chat" | "legacy"; auth?: "key" | "entra"; deployments?: string[]; reasoning_models?: string[]; deployment_type?: DeploymentType; pricing?: Record<string, number> } }) =>
      unwrap(api.PUT("/api/v1/settings/providers", { body: { provider: provider as "azure", api_key: body.api_key, base_url: body.base_url,
        options: { api_version: body.options.api_version ?? "", api_style: body.options.api_style ?? "auto", auth: body.options.auth ?? "key", deployments: body.options.deployments ?? [], reasoning_models: body.options.reasoning_models ?? [],
          deployment_type: body.options.deployment_type ?? "global", pricing: body.options.pricing ?? {} } } })),
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

type AzureStyle = "auto" | "responses" | "chat" | "legacy";
type DeploymentType = "global" | "data_zone" | "regional";
/** gpt-6-luna Standard rates, USD per 1M tokens (backend: app/llm/pricing.py). */
const DEFAULT_RATES = { input: 0.1, cached_input: 0.01, cache_write: 0.125, output: 0.5 };
const RATE_FIELDS = [["input", "Input"], ["cached_input", "Cached input"], ["cache_write", "Cache writes"], ["output", "Output"]] as const;
const DEFAULT_DEPLOYMENT = "gpt-6-luna";

/** Mirrors backend app/llm/azure_v1.py:azure_v1_target so users see exactly which URL Octopus will call. */
export function describeAzureEndpoint(url: string, style: AzureStyle): { ok: boolean; text: string } {
  const u0 = url.trim().split(/[?#]/)[0].replace(/\/+$/, "");
  if (!u0) return { ok: false, text: "" };
  if (!/^https?:\/\//.test(u0)) return { ok: false, text: "The endpoint must start with https://" };
  if (style === "legacy" || u0.includes("/openai/deployments/")) {
    return { ok: true, text: `Legacy API: ${u0.split("/openai")[0]}/openai/deployments/<deployment>/chat/completions?api-version=…` };
  }
  let u = u0, kind: "responses" | "chat" = "responses";
  if (u.endsWith("/responses")) u = u.slice(0, -"/responses".length);
  else if (u.endsWith("/chat/completions")) { u = u.slice(0, -"/chat/completions".length); kind = "chat"; }
  if (u.endsWith("/openai/v1")) { /* already v1 */ } else if (u.endsWith("/openai")) u += "/v1";
  else if (u.endsWith("/models")) u = `${u.slice(0, -"/models".length)}/openai/v1`;
  else u += "/openai/v1";
  if (style === "responses" || style === "chat") kind = style;
  return { ok: true, text: `${kind === "responses" ? "Responses API" : "Chat Completions API"} (v1): ${u}/${kind === "responses" ? "responses" : "chat/completions"}` };
}

function AzureCard({ provider, title, subtitle, info, saved, endpointHint }: {
  provider: "azure"; title: string; subtitle: string; info?: ProviderInfo; saved?: ProviderKeyOut; endpointHint: string;
}) {
  const isOpenAI = provider === "azure";
  const [endpoint, setEndpoint] = React.useState(saved?.base_url ?? "");
  const [key, setKey] = React.useState("");
  const [auth, setAuth] = React.useState<"key" | "entra">((saved?.options.auth as "key" | "entra") ?? "key");
  const [style, setStyle] = React.useState<AzureStyle>((saved?.options.api_style as AzureStyle) ?? "auto");
  const [version, setVersion] = React.useState(saved?.options.api_version || "2024-10-21");
  const [deps, setDeps] = React.useState((saved?.options.deployments ?? []).join("\n") || DEFAULT_DEPLOYMENT);
  const [reasoning, setReasoning] = React.useState((saved?.options.reasoning_models ?? []).join(", "));
  const [advanced, setAdvanced] = React.useState(false);
  const [depType, setDepType] = React.useState<DeploymentType>((saved?.options.deployment_type as DeploymentType) ?? "global");
  const [rates, setRates] = React.useState<Record<string, string>>(Object.fromEntries(Object.entries(saved?.options.pricing ?? {}).map(([k, v]) => [k, String(v)])));
  React.useEffect(() => {
    if (!saved) return;
    setEndpoint(saved.base_url); setAuth((saved.options.auth as "key" | "entra") ?? "key"); setVersion(saved.options.api_version || "2024-10-21");
    setStyle((saved.options.api_style as AzureStyle) ?? "auto");
    setDepType((saved.options.deployment_type as DeploymentType) ?? "global");
    setRates(Object.fromEntries(Object.entries(saved.options.pricing ?? {}).map(([k, v]) => [k, String(v)])));
    setDeps((saved.options.deployments ?? []).join("\n") || DEFAULT_DEPLOYMENT); setReasoning((saved.options.reasoning_models ?? []).join(", "));
  }, [saved]);
  const save = useProviderSave(provider);
  const depList = deps.split(/[\n,]/).map((d) => d.trim()).filter(Boolean);
  const [testModel, setTestModel] = React.useState(depList[0] ?? "");
  React.useEffect(() => { if (!depList.includes(testModel)) setTestModel(depList[0] ?? ""); }, [depList, testModel]);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/api/v1/settings/providers/{provider}", { params: { path: { provider } } })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: qk.settings }); setKey(""); setEndpoint(""); toast.success("Removed"); },
  });
  const detected = isOpenAI ? describeAzureEndpoint(endpoint, style) : null;
  const legacy = isOpenAI && (style === "legacy" || endpoint.includes("/openai/deployments/"));
  const needsKey = auth === "key" && !saved?.masked_key && !key;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-steel/15 text-steel"><Cloud className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{title}</div><div className="truncate text-xs text-muted-foreground">{subtitle}</div></div>
        {info?.configured ? <Badge variant="success"><CheckCircle2 className="h-3 w-3" />Connected</Badge> : <Badge variant="outline">Not connected</Badge>}
      </div>
      <div className="space-y-4 p-4">
        <Step n={1} title="Endpoint" hint={isOpenAI ? "Paste it exactly as the Azure or Foundry portal shows it. Any of these work: resource URL, …/openai/v1, …/openai/v1/responses." : endpointHint}>
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder={endpointHint} className="font-mono text-xs" aria-label={`${title} endpoint`} />
          {detected?.text && (
            <p className={cn("mt-1.5 flex items-start gap-1 break-all text-[11px]", detected.ok ? "text-success" : "text-destructive")}>
              {detected.ok ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0" /> : <XCircle className="mt-px h-3 w-3 shrink-0" />}{detected.text}
            </p>
          )}
        </Step>
        {auth === "key" ? (
          <Step n={2} title="API key" hint={saved?.masked_key ? `Saved: ${saved.masked_key}. Leave empty to keep it.` : "Keys and Endpoint page of the resource. Stored encrypted on this machine."}>
            <div className="relative"><KeyRound className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={saved?.masked_key || "Paste your key"} className="pl-8 font-mono text-xs" autoComplete="off" aria-label={`${title} API key`} /></div>
          </Step>
        ) : (
          <Step n={2} title="Microsoft Entra ID" hint="No key needed.">
            <p className="rounded-md bg-muted/60 p-2 text-[11px] text-muted-foreground">Run <code>az login</code> on this machine. The identity needs the <b>Cognitive Services OpenAI User</b> role.</p>
          </Step>
        )}
        <Step n={3} title={isOpenAI ? "Deployment names" : "Model names"} hint={isOpenAI ? "The name you gave the deployment in Azure, not the model family. One per line. They appear in every agent's model picker." : "One per line. They appear in every agent's model picker."}>
          <Textarea value={deps} onChange={(e) => setDeps(e.target.value)} placeholder={isOpenAI ? "gpt-6-luna\ngpt-4.1-mini" : "DeepSeek-R1\nPhi-4"} className="min-h-[64px] font-mono text-xs" aria-label={isOpenAI ? "Deployment names" : "Model names"} />
        </Step>

        <div>
          <button onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={advanced}>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-180")} />Advanced
          </button>
          {advanced && (
            <div className="mt-3 grid gap-3 rounded-xl border border-border bg-background/50 p-3 sm:grid-cols-2 animate-fade-up">
              <Field label="Authentication">
                <Select value={auth} onValueChange={(v) => setAuth(v as "key" | "entra")} options={[
                  { value: "key", label: "API key", hint: "Keys and Endpoint page of the resource" },
                  { value: "entra", label: "Microsoft Entra ID", hint: "Uses az login / managed identity / env credentials" }]} />
              </Field>
              {isOpenAI && (
                <Field label="API">
                  <Select value={style} onValueChange={(v) => setStyle(v as AzureStyle)} options={[
                    { value: "auto", label: "Automatic (recommended)", hint: "Detected from the endpoint; Responses API by default" },
                    { value: "responses", label: "v1 Responses API", hint: "/openai/v1/responses" },
                    { value: "chat", label: "v1 Chat Completions", hint: "/openai/v1/chat/completions" },
                    { value: "legacy", label: "Legacy (api-version)", hint: "/openai/deployments/<name>/…?api-version=" }]} />
                </Field>
              )}
              {legacy && <Field label="API version" hint="Legacy API only"><Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono text-xs" /></Field>}
              <Field label="Reasoning deployments" hint="Optional. Octopus drops parameters a deployment rejects (like temperature) automatically. List them here to skip that first retry.">
                <Input value={reasoning} onChange={(e) => setReasoning(e.target.value)} placeholder="gpt-6-luna, o4-mini" className="font-mono text-xs" />
              </Field>
              <Field label="Deployment type" hint="Data Zone and regional deployments cost 10% more.">
                <Select value={depType} onValueChange={(v) => setDepType(v as DeploymentType)} ariaLabel="Deployment type" options={[
                  { value: "global", label: "Global Standard" }, { value: "data_zone", label: "Data Zone Standard (+10%)" }, { value: "regional", label: "Regional (+10%)" }]} />
              </Field>
              <div className="sm:col-span-2">
                <div className="mb-1 text-xs font-medium">Pricing <span className="font-normal text-muted-foreground">(USD per 1M tokens, empty = gpt-6-luna list price)</span></div>
                <div className="grid grid-cols-4 gap-2">
                  {RATE_FIELDS.map(([k, label]) => (
                    <label key={k} className="space-y-1 text-[11px] text-muted-foreground">{label}
                      <Input type="number" step="0.001" min="0" value={rates[k] ?? ""} placeholder={String(DEFAULT_RATES[k])} aria-label={`${label} price`}
                        onChange={(e) => setRates({ ...rates, [k]: e.target.value })} className="h-8 font-mono text-xs" />
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-[10.5px] text-muted-foreground">Costs use the exact token counts Azure returns: uncached input, cached input, cache writes and output (reasoning included). Prompts over 272K tokens bill 2× input and 1.5× output.</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-background/40 px-4 py-2.5">
        <Button size="sm" loading={save.isPending} disabled={!endpoint || needsKey || (detected ? !detected.ok : false)} title={needsKey ? "Add an API key" : undefined}
          onClick={() => save.mutate({ api_key: key, base_url: endpoint, options: { api_version: legacy ? version : "", api_style: style, auth, deployments: depList, reasoning_models: reasoning.split(",").map((x) => x.trim()).filter(Boolean),
            deployment_type: depType, pricing: Object.fromEntries(Object.entries(rates).filter(([, v]) => v !== "" && !Number.isNaN(Number(v))).map(([k, v]) => [k, Number(v)])) } })}>Save</Button>
        {depList.length > 1 && <Select value={testModel} onValueChange={setTestModel} options={depList.map((d) => ({ value: d, label: d }))} className="h-8 w-40 text-xs" ariaLabel="Deployment to test" />}
        <TestButton provider={provider} model={testModel || depList[0] || ""} disabled={!info?.configured} />
        {saved && <Button size="sm" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => remove.mutate()}><Trash2 />Remove</Button>}
      </div>
    </div>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{n}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-sm font-medium">{title}</div>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
        {children}
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
      <BrowserCard />
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
                <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", s.last_error ? "bg-destructive/15 text-destructive" : "bg-olive/15 text-olive")}><Server className="h-4 w-4" /></div>
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

type BadgeVariant = "success" | "destructive" | "outline" | "warning";
/** Browser health: green only once a real browser rendered a page (the MCP server answering is not enough). */
export function browserBadge(status?: string): { label: string; variant: BadgeVariant } {
  switch (status) {
    case "ready": return { label: "Browser working", variant: "success" };
    case "server_ready": return { label: "Not verified yet", variant: "warning" };
    case "starting": return { label: "Starting…", variant: "outline" };
    case "installing": return { label: "Installing browser…", variant: "outline" };
    case "error": return { label: "Can't launch", variant: "destructive" };
    case "stopped": case undefined: return { label: "Starts on first use", variant: "outline" };
    default: return { label: status, variant: "outline" };
  }
}

/** Octopus starts Playwright MCP itself on 127.0.0.1; every agent with the Browser tool gets its own tab. */
function BrowserCard() {
  const status = useQuery({ queryKey: ["browser-status"], queryFn: () => unwrap(api.GET("/api/v1/settings/browser")), refetchInterval: 5000 });
  const [res, setRes] = React.useState<{ ok: boolean; detail: string; latency_ms: number } | null>(null);
  const test = useMutation({
    mutationFn: () => unwrap(api.POST("/api/v1/settings/browser/test")), onMutate: () => setRes(null),
    onSuccess: (r) => { setRes(r); status.refetch(); },
  });
  const st = status.data;
  const { label, variant } = browserBadge(st?.status);
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-olive/15 text-olive"><Globe className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">Built-in browser<Badge variant="outline">Playwright MCP</Badge></div>
          <div className="text-xs text-muted-foreground">Managed by Octopus on this machine. Agents with the <b>Browser</b> tool (on by default) get their own tab to open the project preview, click through it and read console errors.</div>
        </div>
        {st && <Badge variant={st.enabled ? variant : "outline"}>{st.enabled ? label : "Disabled"}</Badge>}
      </div>
      {st?.error && (
        <div className="mt-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          <p className="font-medium">{st.error.split("\n")[0]}</p>
          {st.error.includes("\n") && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] opacity-80">{st.error.split("\n").slice(1).join("\n")}</pre>}
          <p className="mt-1 text-[11px] opacity-90">Until this is fixed, agents can only check the project by reading its source: nothing is tested in a real browser.</p>
        </div>
      )}
      {st && !st.node && <p className="mt-2 rounded-md bg-warning/10 p-2 text-xs text-warning">Node.js 18+ (npx) is needed for the browser. Install it from nodejs.org.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => test.mutate()} loading={test.isPending} disabled={!st?.enabled}><Wifi />Test browser</Button>
        {test.isPending && <span className="text-xs text-muted-foreground">The first run downloads the browser, which can take a minute.</span>}
        {res && <span className={cn("flex items-center gap-1 text-xs", res.ok ? "text-success" : "text-destructive")}>{res.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{res.detail}{res.latency_ms ? <span className="text-muted-foreground">· {res.latency_ms}ms</span> : null}</span>}
        {st && (
          <Tip content="The tool count comes from the MCP server; it says nothing about whether a browser can launch (that's the badge).">
            <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{st.package} · {st.browser} · MCP server {["server_ready", "ready"].includes(st.status) ? "up" : "not running"} · {st.tools?.length ?? 0} tools</span>
          </Tip>
        )}
      </div>
    </div>
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

/** "Preferences": per-device display settings (theme, currency). Section key stays "appearance" for deep links. */
function Appearance() {
  const { theme, setTheme } = useApp();
  return (
    <>
    <div>
      <h1 className="text-lg font-semibold">Preferences</h1>
      <p className="text-sm text-muted-foreground">How Octopus looks and shows costs on this device.</p>
    </div>
    <Section title="Theme">
      <div className="grid grid-cols-2 gap-3">
        {(["dark", "light"] as const).map((t) => (
          <button key={t} onClick={() => setTheme(t)} className={cn("rounded-xl border p-4 text-left transition hover:border-primary/50", theme === t ? "border-primary bg-primary/5" : "border-border")}>
            <div className={cn("mb-3 h-16 rounded-lg border", t === "dark" ? "border-[#444442] bg-[#1F1E1D]" : "border-[#DEDCD4] bg-[#FAF9F5]")} />
            <span className="flex items-center gap-1.5 text-sm font-medium">{t === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}{t === "dark" ? "Dark" : "Light"}</span>
          </button>
        ))}
      </div>
    </Section>
    <CurrencySection />
    </>
  );
}

/** Costs are billed and stored in USD; this only changes how they're displayed, using live exchange rates. */
function CurrencySection() {
  const { currency, setCurrency } = useApp();
  const fx = useFxRate();
  const known = CURRENCIES.some((c) => c.code === currency);
  const [custom, setCustom] = React.useState(known ? "" : currency);
  const [other, setOther] = React.useState(!known);
  const sample = 1.2345;
  return (
    <Section title="Currency" description="Azure bills in US dollars. Costs are stored in USD and shown in your currency using live exchange rates.">
      <div role="radiogroup" aria-label="Display currency" className="grid gap-2 sm:grid-cols-3">
        {CURRENCIES.map((c) => (
          <button key={c.code} type="button" role="radio" aria-checked={!other && currency === c.code} onClick={() => { setOther(false); setCurrency(c.code); }}
            className={cn("flex items-center gap-2 rounded-xl border p-2.5 text-left text-sm transition hover:border-primary/50",
              !other && currency === c.code ? "border-primary bg-primary/5" : "border-border")}>
            <span className="w-9 font-mono text-xs font-semibold">{c.code}</span>
            <span className="min-w-0 flex-1 truncate">{c.label}</span>
            {c.code === "USD" && <span className="rounded-full bg-olive/15 px-1.5 py-px text-[10px] font-semibold uppercase text-olive">Recommended</span>}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={other} onClick={() => setOther(true)}
          className={cn("flex items-center gap-2 rounded-xl border border-dashed p-2.5 text-left text-sm transition hover:border-primary/50", other ? "border-primary bg-primary/5" : "border-border")}>
          <span className="w-9 font-mono text-xs font-semibold">···</span><span>Other currency</span>
        </button>
      </div>
      {other && (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (/^[A-Za-z]{3}$/.test(custom)) setCurrency(custom); }}>
          <Input value={custom} onChange={(e) => setCustom(e.target.value.toUpperCase().slice(0, 3))} placeholder="ISO code, e.g. BRL" className="h-8 w-40 font-mono text-xs" aria-label="Currency code" />
          <Button size="sm" type="submit" disabled={!/^[A-Za-z]{3}$/.test(custom)}>Use</Button>
        </form>
      )}
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs">
        {currency === "USD" ? <span className="text-muted-foreground">Showing costs in US dollars: {formatMoney(sample, "USD", 1)}.</span>
          : fx.error ? <span className="text-destructive">Couldn't load the {currency} rate ({fx.error.message}). Costs are shown in USD until it's available.</span>
          : fx.info ? (
            <span className="text-muted-foreground">
              1 USD = <b className="text-foreground">{fx.info.rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} {fx.info.currency}</b>
              {" · "}$1.2345 shows as <b className="text-foreground">{formatMoney(sample, fx.info.currency, fx.info.rate)}</b>
              {" · "}{fx.info.source}{fx.info.date ? `, ${fx.info.date}` : ""}{fx.info.stale ? " (offline: last known rate)" : ""}
            </span>
          ) : <span className="text-muted-foreground">Loading the {currency} rate…</span>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- templates
function TemplatesSection() {
  const { data, isLoading } = useTemplates();
  const qc = useQueryClient();
  const mine = (data ?? []).filter((t) => t.source === "user");
  const builtin = (data ?? []).filter((t) => t.source === "builtin");
  const [renaming, setRenaming] = React.useState<{ key: string; name: string; description: string } | null>(null);
  const [del, setDel] = React.useState<{ key: string; name: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["templates"] });
  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/api/v1/templates/{key}", { params: { path: { key: renaming!.key } }, body: { name: renaming!.name, description: renaming!.description } })),
    onSuccess: () => { refresh(); setRenaming(null); toast.success("Template updated"); },
  });
  const remove = useMutation({
    mutationFn: (key: string) => unwrap(api.DELETE("/api/v1/templates/{key}", { params: { path: { key } } })),
    onSuccess: () => { refresh(); toast.success("Template deleted"); },
  });
  const exportTpl = async (key: string, name: string) => {
    const spec = await unwrap(api.GET("/api/v1/templates/{key}/spec", { params: { path: { key } } }));
    download(`${name.replace(/\W+/g, "-").toLowerCase()}.octopus-template.json`, JSON.stringify(spec, null, 2), "application/json");
  };
  const importTpl = async (f: File) => {
    try {
      const spec = JSON.parse(await f.text());
      await unwrap(api.POST("/api/v1/templates", { body: { name: spec.name ?? f.name.replace(/\..*$/, ""), description: spec.description ?? "", spec } }));
      refresh();
      toast.success(`Imported ${spec.name ?? "template"}`);
    } catch (e) { toast.error("Import failed", { description: (e as Error).message }); }
  };
  return (
    <Section title="Company templates" description="Templates are sets of departments. Each department has a manager and a small team. Design one on the canvas and use Save as template, generate one with AI in New company, or import a JSON file. Templates are available in every project.">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}><Upload />Import JSON</Button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importTpl(f); e.target.value = ""; }} />
      </div>
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">My templates</div>
        {isLoading ? <div className="skeleton h-16" /> : !mine.length ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No custom templates yet. Open a company on the canvas and click <b>Save as template</b>.</div>
        ) : mine.map((t) => (
          <div key={t.key} className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{t.name}</div>
              <div className="truncate text-xs text-muted-foreground">{t.description || `${t.agent_count} agents · ${t.edge_count} channels`}</div>
              <div className="mt-1"><DepartmentChips departments={t.departments ?? []} /></div>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Rename" onClick={() => setRenaming({ key: t.key, name: t.name, description: t.description })}><Pencil /></Button>
            <Button size="icon-sm" variant="ghost" aria-label="Export" onClick={() => void exportTpl(t.key, t.name)}><Download /></Button>
            <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Delete" onClick={() => setDel({ key: t.key, name: t.name })}><Trash2 /></Button>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Built-in</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {builtin.map((t) => (
            <div key={t.key} className="rounded-xl border border-border bg-surface p-3">
              <div className="flex items-center justify-between"><span className="text-sm font-medium">{t.name}</span>
                <Button size="icon-sm" variant="ghost" aria-label={`Export ${t.name}`} onClick={() => void exportTpl(t.key, t.name)}><Download /></Button></div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
              <div className="mt-1.5"><DepartmentChips departments={t.departments ?? []} /></div>
            </div>
          ))}
        </div>
      </div>
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit template</DialogTitle></DialogHeader>
          {renaming && (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
              <Field label="Name"><Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} /></Field>
              <Field label="Description"><Textarea value={renaming.description} onChange={(e) => setRenaming({ ...renaming, description: e.target.value })} /></Field>
              <div className="flex justify-end"><Button type="submit" loading={rename.isPending}>Save</Button></div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete "${del?.name}"?`} destructive confirmLabel="Delete"
        description="Companies already created from it are not affected." onConfirm={() => del && remove.mutate(del.key)} />
    </Section>
  );
}
