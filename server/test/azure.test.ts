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
