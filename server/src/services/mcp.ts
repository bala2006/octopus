/**
 * MCP connections: the servers you register in Settings, plus the built-in browser (Playwright MCP, isolated profile,
 * one per project). Clients connect on first use and are reused; tools are exposed to the agents you grant them to.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { McpToolOut } from "@octopus/shared";
import { config } from "../config";
import type { McpRow, Registry } from "../db/registry";
import { safeEnv } from "../lib/proc";
import { decrypt } from "../lib/secrets";
import { clip, parseJson } from "../lib/util";
import type { Tool, ToolContext } from "../tools/types";

interface Connection { client: Client; tools: McpToolOut[]; lastUsed: number }
const connections = new Map<string, Promise<Connection>>();
export const BROWSER_PACKAGE = "@playwright/mcp@latest";

async function connect(transport: () => StdioClientTransport | StreamableHTTPClientTransport): Promise<Connection> {
  const client = new Client({ name: "octopus", version: "2.0.0" });
  await client.connect(transport());
  const { tools } = await client.listTools();
  return { client, lastUsed: Date.now(), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Record<string, unknown> })) };
}

function cached(key: string, make: () => Promise<Connection>): Promise<Connection> {
  let c = connections.get(key);
  if (!c) {
    c = make();
    connections.set(key, c);
    c.catch(() => connections.delete(key));
  }
  return c.then((conn) => { conn.lastUsed = Date.now(); return conn; });
}

export function serverConnection(server: McpRow): Promise<Connection> {
  return cached(`server:${server.id}:${server.updated_at}`, () => connect(() => {
    const env = parseJson<Record<string, string>>(decrypt(server.env_enc), {});
    if (server.transport === "http") return new StreamableHTTPClientTransport(new URL(server.url));
    if (!config.allowStdioMcp) throw new Error("stdio MCP servers are disabled (MCP_ALLOW_STDIO=false)");
    return new StdioClientTransport({ command: server.command, args: server.args, env: { ...safeEnv(), ...env } as Record<string, string>, stderr: "ignore" });
  }));
}

export function browserConnection(root: string): Promise<Connection> {
  if (!config.browserEnabled) return Promise.reject(new Error("The built-in browser is turned off (BROWSER_ENABLED=false)"));
  const out = path.join(root, ".octopus", "browser");
  return cached(`browser:${root}`, () => connect(() => new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", BROWSER_PACKAGE, "--isolated", ...(config.browserHeadless ? ["--headless"] : []), "--output-dir", out],
    env: safeEnv() as Record<string, string>, cwd: root, stderr: "ignore",
  })));
}

/** Close connections idle for 10 minutes, and everything on shutdown. */
export async function closeIdle(maxIdleMs = 10 * 60_000) {
  for (const [key, c] of connections) {
    const conn = await c.catch(() => null);
    if (!conn || Date.now() - conn.lastUsed > maxIdleMs) { connections.delete(key); await conn?.client.close().catch(() => {}); }
  }
}
setInterval(() => void closeIdle(), 60_000).unref();

type Content = { type: string; text?: string; data?: string; mimeType?: string };
function render(res: Record<string, unknown>): { text: string; image?: string; ok: boolean } {
  const parts = (res.content ?? []) as Content[];
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const img = parts.find((p) => p.type === "image" && p.data);
  return { text: clip(text || (img ? "(screenshot taken)" : "(no output)"), 20_000), image: img ? `data:${img.mimeType ?? "image/png"};base64,${img.data}` : undefined, ok: !res.isError };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
let frameCounter = 0;

function saveFrame(ctx: ToolContext, dataUrl: string): string {
  const dir = path.join(ctx.fs.root, ".octopus", "browser", ctx.runId);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now().toString(36)}-${frameCounter++}.png`;
  writeFileSync(path.join(dir, name), Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
  return name;
}

/** Built-in browser tools for an agent (the Playwright MCP tool list, with browser_action events and screenshots). */
export async function browserTools(root: string): Promise<Tool[]> {
  const conn = await browserConnection(root);
  return conn.tools.map((t): Tool => ({
    name: safeName(t.name), description: t.description ?? t.name, args: z.record(z.string(), z.unknown()),
    parameters: t.input_schema ?? { type: "object", properties: {} },
    async run(ctx, args, callId) {
      ctx.setStatus("tool", `Browser: ${t.name.replace(/^browser_/, "").replace(/_/g, " ")}`);
      const res = render(await (await browserConnection(root)).client.callTool({ name: t.name, arguments: args }));
      const url = /Page URL: (\S+)/.exec(res.text)?.[1] ?? "";
      const title = /Page Title: (.+)/.exec(res.text)?.[1]?.trim() ?? "";
      ctx.emit("browser_action", { agent_id: ctx.agent.id, call_id: callId, tool: t.name, args, ok: res.ok, url, title, frame: res.image ? saveFrame(ctx, res.image) : null });
      return { text: res.text, ok: res.ok, image: res.image };
    },
  }));
}

/** Tools of the MCP servers granted to an agent, named `mcp__<server>__<tool>`; every call asks in "ask" mode. */
export async function serverTools(reg: Registry, names: string[]): Promise<Tool[]> {
  const servers = reg.mcp.find("enabled = 1").filter((s) => names.includes(s.name) || names.includes(s.id));
  const lists = await Promise.all(servers.map(async (server) => {
    try {
      const conn = await serverConnection(server);
      return conn.tools.slice(0, 40).map((t): Tool => ({
        name: safeName(`mcp__${server.name}__${t.name}`), description: `[${server.name}] ${t.description ?? t.name}`,
        args: z.record(z.string(), z.unknown()), parameters: t.input_schema ?? { type: "object", properties: {} },
        async run(ctx, args) {
          await ctx.guard({ kind: "mcp_call", risk: "medium", summary: `Use ${server.name} → ${t.name}`, details: { server: server.name, tool: t.name, arguments: args }, key: `mcp:${server.name}:${t.name}` });
          ctx.setStatus("tool", `${server.name}: ${t.name}`);
          const res = render(await (await serverConnection(server)).client.callTool({ name: t.name, arguments: args }));
          return { text: res.text, ok: res.ok, image: res.image };
        },
      }));
    } catch (e) {
      reg.mcp.update(server.id, { last_error: (e as Error).message });
      return [];
    }
  }));
  return lists.flat();
}

/** Connect to a registered server, refresh its tool list and record the result. */
export async function refreshServer(reg: Registry, server: McpRow): Promise<McpRow> {
  for (const key of connections.keys()) if (key.startsWith(`server:${server.id}:`)) connections.delete(key);
  try {
    const conn = await serverConnection(server);
    return reg.mcp.update(server.id, { tools: conn.tools, last_error: "" })!;
  } catch (e) {
    return reg.mcp.update(server.id, { last_error: (e as Error).message, tools: [] })!;
  }
}
