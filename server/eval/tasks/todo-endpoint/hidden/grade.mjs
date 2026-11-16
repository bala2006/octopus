import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";

const { createTodoServer } = await import(pathToFileURL(path.resolve("src/app.js")).href);
const server = createTodoServer();
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const json = { "content-type": "application/json" };
const send = (method, url, body) =>
  fetch(base + url, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
const checks = [];

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, detail: String(error.message).split("\n")[0] });
  }
}

const made = await (await send("POST", "/todos", { title: "milk" })).json();

await check("PATCH marks a todo done and returns it", async () => {
  const res = await send("PATCH", `/todos/${made.id}`, { done: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.done, true);
  assert.equal(body.title, "milk");
});

await check("PATCH changes the title and keeps done", async () => {
  const res = await send("PATCH", `/todos/${made.id}`, { title: "oat milk" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.title, "oat milk");
  assert.equal(body.done, true);
});

await check("the change is visible to GET", async () => {
  const body = await (await send("GET", `/todos/${made.id}`)).json();
  assert.equal(body.title, "oat milk");
  assert.equal(body.done, true);
});

await check("PATCH on an unknown id is 404", async () => {
  assert.equal((await send("PATCH", "/todos/999", { done: true })).status, 404);
});

await check("PATCH with done as a string is 400", async () => {
  assert.equal((await send("PATCH", `/todos/${made.id}`, { done: "yes" })).status, 400);
});

await check("PATCH with an empty title is 400", async () => {
  assert.equal((await send("PATCH", `/todos/${made.id}`, { title: "   " })).status, 400);
});

await check("PATCH with invalid JSON is 400", async () => {
  const res = await fetch(base + `/todos/${made.id}`, { method: "PATCH", headers: json, body: "{" });
  assert.equal(res.status, 400);
});

server.closeAllConnections();
server.close();
console.log(JSON.stringify({ checks }));
