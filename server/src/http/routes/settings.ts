/** Settings: the Azure OpenAI connection, approval mode, currency rates, the browser and MCP servers. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ApprovalModeInSchema, McpServerInSchema, ProviderKeyInSchema, TestProviderInSchema,
  type McpServerOut, type ProviderKeyOut, type ProviderOptions, type SettingsOut,
} from "@octopus/shared";
import { config } from "../../config";
import type { McpRow, Registry } from "../../db/registry";
import { complete, connection, deployments, normalizeEndpoint } from "../../llm/azure";
import { decrypt, encrypt, mask } from "../../lib/secrets";
import { newId, notFound, now, parseJson, UserError } from "../../lib/util";
import { usdRate } from "../../services/fx";
import { BROWSER_PACKAGE, browserConnection, refreshServer } from "../../services/mcp";
import type { RouteFn } from "../router";

type SavedProvider = { base_url: string; key_enc: string; options: ProviderOptions; updated_at: string };

function keyOut(reg: Registry): ProviderKeyOut[] {
  const saved = reg.setting<SavedProvider | null>("provider.azure", null);
  if (!saved) return [];
  return [{ provider: "azure", base_url: saved.base_url, masked_key: mask(decrypt(saved.key_enc)), options: saved.options, updated_at: saved.updated_at }];
}

function settings(reg: Registry): SettingsOut {
  return {
    approval_mode: reg.setting("approval_mode", "ask"), default_provider: "azure", default_model: config.defaultModel, single_user_mode: true,
    providers: [{ provider: "azure", label: "Azure OpenAI", configured: !!connection(reg), needs_key: true, needs_base: true, models: deployments(reg) }],
    keys: keyOut(reg),
  };
}

const mcpOut = (r: McpRow): McpServerOut => ({
  id: r.id, name: r.name, transport: r.transport, command: r.command, args: r.args, url: r.url, enabled: r.enabled, tools: r.tools,
  last_error: r.last_error, updated_at: r.updated_at, env_keys: Object.keys(parseJson<Record<string, string>>(decrypt(r.env_enc), {})),
});

export function settingsRoutes(route: RouteFn, reg: Registry) {
  route("GET", "/api/v1/settings", () => settings(reg));
  route("PUT", "/api/v1/settings/approval-mode", ApprovalModeInSchema, ({ body }) => {
    reg.setSetting("approval_mode", body.approval_mode);
    return { approval_mode: body.approval_mode };
  });
  route("PUT", "/api/v1/settings/providers", ProviderKeyInSchema, ({ body }) => {
    const prev = reg.setting<SavedProvider | null>("provider.azure", null);
    const { baseUrl, deployment } = normalizeEndpoint(body.base_url ?? prev?.base_url ?? "");
    if (!baseUrl) throw new UserError("Paste your Azure OpenAI endpoint");
    const options = { ...(prev?.options ?? {}), ...(body.options ?? {}) };
    if (deployment) options.deployments = [...new Set([deployment, ...(options.deployments ?? [])])];
    const key = body.api_key?.trim();
    reg.setSetting("provider.azure", { base_url: body.base_url?.trim() || prev?.base_url || baseUrl, key_enc: key ? encrypt(key) : prev?.key_enc ?? "", options, updated_at: now() });
    return keyOut(reg)[0]!;
  });
  route("DELETE", "/api/v1/settings/providers/{provider}", () => { reg.deleteSetting("provider.azure"); return { ok: true }; });
  route("POST", "/api/v1/settings/providers/test", TestProviderInSchema, async ({ body }) => {
    const started = Date.now();
    try {
      const res = await complete(reg, { model: body.model || config.defaultModel, instructions: "Reply with the single word OK.", input: [{ role: "user", content: "Test" }], effort: "low", maxOutputTokens: 400 });
      return { ok: true, detail: `Connected to ${body.model}. Reply: ${res.text.trim().slice(0, 40) || "(empty)"}`, latency_ms: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, latency_ms: Date.now() - started };
    }
  });
  route("GET", "/api/v1/settings/fx", ({ query }) => usdRate(query.currency));

  route("GET", "/api/v1/settings/browser", () => ({
    enabled: config.browserEnabled, status: config.browserEnabled ? "ready" : "disabled", browser: "Chrome (or Chrome for Testing)", package: BROWSER_PACKAGE,
    node: true, verified: false, tools: [],
  }));
  route("POST", "/api/v1/settings/browser/test", async () => {
    const started = Date.now();
    try {
      const dir = path.join(config.home, "browser-test");
      mkdirSync(path.join(dir, ".octopus"), { recursive: true });
      const conn = await browserConnection(dir);
      return { ok: true, detail: `Browser ready with ${conn.tools.length} tools`, latency_ms: Date.now() - started };
    } catch (e) {
      return { ok: false, detail: (e as Error).message, latency_ms: Date.now() - started };
    }
  });

  route("GET", "/api/v1/mcp-servers", () => reg.mcp.find().map(mcpOut));
  const saveMcp = (id: string, body: ReturnType<typeof McpServerInSchema.parse>, prev?: McpRow): McpRow => {
    const transport = body.transport ?? "stdio";
    if (transport === "stdio" && !body.command) throw new UserError("Give the command that starts the server");
    if (transport === "http" && !/^https?:\/\//.test(body.url ?? "")) throw new UserError("Give the server's http(s) URL");
    if (reg.mcp.one("name = ? AND id != ?", [body.name, id])) throw new UserError(`A server called ${body.name} already exists`, 409);
    const env = { ...parseJson<Record<string, string>>(decrypt(prev?.env_enc ?? ""), {}), ...(body.env ?? {}) };
    return reg.mcp.upsert({ id, name: body.name, transport, command: body.command ?? "", args: body.args ?? [], url: body.url ?? "", env_enc: encrypt(JSON.stringify(env)),
      enabled: body.enabled ?? true, tools: prev?.tools ?? [], last_error: "", updated_at: now() });
  };
  route("POST", "/api/v1/mcp-servers", McpServerInSchema, async ({ body }) => mcpOut(await refreshServer(reg, saveMcp(newId(), body))));
  route("PUT", "/api/v1/mcp-servers/{server_id}", McpServerInSchema, async ({ params, body }) => {
    const prev = reg.mcp.get(params.server_id);
    if (!prev) throw notFound("MCP server");
    return mcpOut(await refreshServer(reg, saveMcp(prev.id, body, prev)));
  });
  route("DELETE", "/api/v1/mcp-servers/{server_id}", ({ params }) => { reg.mcp.remove(params.server_id); return { ok: true }; });
  route("POST", "/api/v1/mcp-servers/{server_id}/refresh", async ({ params }) => {
    const s = reg.mcp.get(params.server_id);
    if (!s) throw notFound("MCP server");
    return mcpOut(await refreshServer(reg, s));
  });
}
