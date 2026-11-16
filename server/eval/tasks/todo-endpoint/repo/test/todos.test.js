import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createTodoServer } from "../src/app.js";

test("a todo can be created and listed", async () => {
  const server = createTodoServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/todos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "milk" }),
    });
    assert.equal(created.status, 201);
    const list = await (await fetch(`${base}/todos`)).json();
    assert.equal(list.length, 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
