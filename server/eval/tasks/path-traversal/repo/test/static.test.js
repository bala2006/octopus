import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "../src/server.js";

test("index.html is served from public/", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const server = createStaticServer(root);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/index.html`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>Hello from public<\/h1>/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
