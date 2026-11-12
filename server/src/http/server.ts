/**
 * The HTTP server: one local origin for the web app, the REST API and the sockets. Requests must come from this
 * computer by name (127.0.0.1 or localhost), which blocks DNS-rebinding and cross-site requests to the local API.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyError } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "../config";
import type { Registry } from "../db/registry";
import { UserError } from "../lib/util";
import { router } from "./router";
import { catalogRoutes } from "./routes/catalog";
import { companyRoutes } from "./routes/companies";
import { conversationRoutes } from "./routes/conversations";
import { editorRoutes } from "./routes/editor";
import { fileRoutes } from "./routes/files";
import { settingsRoutes } from "./routes/settings";
import { systemRoutes } from "./routes/system";
import { wsRoutes } from "./ws";

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export async function buildServer(reg: Registry, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ? { level: "warn" } : false, bodyLimit: 60 * 1024 * 1024 });
  await app.register(websocket);
  await app.register(multipart);

  app.addHook("onRequest", async (req, reply) => {
    if (!LOCAL_HOST.test(req.headers.host ?? "")) return reply.code(421).send({ detail: "Octopus only answers requests addressed to 127.0.0.1 or localhost" });
    const origin = req.headers.origin;
    // Sandboxed pages (including project previews) send "Origin: null": they may load files, never change anything.
    const changes = req.method !== "GET" && req.method !== "HEAD" || !!req.headers.upgrade;
    if (origin === "null") { if (changes) return reply.code(403).send({ detail: "Requests from sandboxed pages are not allowed" }); }
    else if (origin) {
      try { if (!LOCAL_HOST.test(new URL(origin).host)) return reply.code(403).send({ detail: "Cross-site requests are not allowed" }); } catch { return reply.code(403).send({ detail: "Bad origin" }); }
    }
  });

  app.setErrorHandler((err: FastifyError | UserError | Error, _req, reply) => {
    if (err instanceof UserError) return reply.code(err.status).send({ detail: err.message });
    const status = (err as FastifyError).statusCode;
    if (status && status < 500) return reply.code(status).send({ detail: err.message });
    console.error(err);
    return reply.code(500).send({ detail: "Something went wrong on the Octopus server. Details are in its console." });
  });

  const route = router(app, reg);
  systemRoutes(route, app, reg);
  settingsRoutes(route, reg);
  catalogRoutes(route, reg);
  companyRoutes(route, reg);
  conversationRoutes(route, app, reg);
  fileRoutes(route, app, reg);
  editorRoutes(route, app, reg);
  wsRoutes(app, reg);

  if (existsSync(path.join(config.webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/ws/")) return reply.code(404).send({ detail: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
