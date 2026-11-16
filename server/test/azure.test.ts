import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRegistry } from "../src/db/registry";
import { complete } from "../src/llm/azure";
import { encrypt } from "../src/lib/secrets";

/** A deployment that is busy once: the first request is rate limited with a one-second retry-after. */
async function busyOnceServer(): Promise<{ url: string; attempts: () => number; close(): Promise<void> }> {
  let attempts = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "Too many requests" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const response = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 3, output_tokens: 1 } };
      res.write(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, attempts: () => attempts, close: () => new Promise((r) => server.close(() => r())) };
}

describe("model time", () => {
  test("a call's model time includes the first response wait and the retry wait, not only the last attempt", async () => {
    const server = await busyOnceServer();
    const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "azure-")), "registry.db"));
    reg.setSetting("provider.azure", { base_url: server.url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
    try {
      const started = Date.now();
      const result = await complete(reg, { model: "test-model", instructions: "Say hi.", input: [{ role: "user", content: "hi" }] });
      const elapsed = Date.now() - started;
      expect(server.attempts()).toBe(2);
      expect(result.text).toBe("hi");
      expect(result.ms).toBeGreaterThanOrEqual(900);
      expect(result.ms).toBeLessThanOrEqual(elapsed);
    } finally {
      await server.close();
    }
  });
});

/** A deployment that records each request body and answers with the next reply, repeating the last one. */
async function recordingServer(replies: { status: number; body: Record<string, unknown> }[]): Promise<{ url: string; bodies: Record<string, unknown>[]; close(): Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const reply = replies[Math.min(bodies.length, replies.length) - 1]!;
      if (reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.body));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: reply.body })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise((r) => server.close(() => r())) };
}

const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 3, output_tokens: 1 }, ...extra,
});

function registryAt(url: string) {
  const reg = openRegistry(path.join(mkdtempSync(path.join(tmpdir(), "azure-cache-")), "registry.db"));
  reg.setSetting("provider.azure", { base_url: url, key_enc: encrypt("test-key"), options: { auth: "key" }, updated_at: "" });
  return reg;
}

describe("prompt cache", () => {
  test("the request carries the cache key and a 24-hour retention", async () => {
    const server = await recordingServer([{ status: 200, body: answer("hi") }]);
    try {
      await complete(registryAt(server.url), { model: "cache-model", instructions: "Say hi.", input: [{ role: "user", content: "hi" }], promptCacheKey: "conv-1:agent-1:orchestrator" });
      expect(server.bodies[0]).toMatchObject({ prompt_cache_key: "conv-1:agent-1:orchestrator", prompt_cache_retention: "24h" });
    } finally {
      await server.close();
    }
  });

  test("a deployment that rejects the cache key gets the request again without it", async () => {
    const server = await recordingServer([
      { status: 400, body: { error: { message: "Unsupported parameter: 'prompt_cache_key'." } } },
      { status: 200, body: answer("hi") },
    ]);
    try {
      const result = await complete(registryAt(server.url), { model: "cache-model-rejects", instructions: "Say hi.", input: [{ role: "user", content: "hi" }], promptCacheKey: "conv-1:agent-1:worker" });
      expect(server.bodies).toHaveLength(2);
      expect(server.bodies[0]).toHaveProperty("prompt_cache_key");
      expect(server.bodies[1]).not.toHaveProperty("prompt_cache_key");
      expect(result.text).toBe("hi");
    } finally {
      await server.close();
    }
  });

  test("input transformations that remove reasoning items are counted", async () => {
    const server = await recordingServer([{ status: 200, body: answer("hi", { input_transformations: [{ id: "rs_1", reason: "prefix_mismatch" }, { id: "msg_1", reason: "prefix_mismatch" }] }) }]);
    try {
      const result = await complete(registryAt(server.url), { model: "cache-model-counts", instructions: "Say hi.", input: [{ role: "user", content: "hi" }] });
      expect(result.reasoningDropped).toBe(1);
    } finally {
      await server.close();
    }
  });
});