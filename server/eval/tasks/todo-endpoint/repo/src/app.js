import { createServer } from "node:http";

/** A todo API held in memory. */
export function createTodoServer() {
  const todos = new Map();
  let nextId = 1;

  return createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/todos" && req.method === "GET") return send(200, [...todos.values()]);

    if (url.pathname === "/todos" && req.method === "POST") {
      const body = await readBody(req);
      if (typeof body?.title !== "string" || !body.title.trim()) return send(400, { error: "title is required" });
      const todo = { id: nextId++, title: body.title.trim(), done: false };
      todos.set(todo.id, todo);
      return send(201, todo);
    }

    const match = /^\/todos\/(\d+)$/.exec(url.pathname);
    if (match && req.method === "GET") {
      const todo = todos.get(Number(match[1]));
      return todo ? send(200, todo) : send(404, { error: "not found" });
    }

    send(404, { error: "not found" });
  });
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "null");
  } catch {
    return undefined;
  }
}
