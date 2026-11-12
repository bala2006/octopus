/**
 * Typed routes: a handler is registered against the shared `ApiRoutes` map, so its path, parameters, body and response
 * type are checked against what the web app calls. Bodies are validated with the route's zod schema.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiPath, MethodsOf, PathParams, Route } from "@octopus/shared";
import type { Registry } from "../db/registry";
import { UserError } from "../lib/util";
import { project, type Project } from "../workspace/projects";

type Input<P extends ApiPath, M extends MethodsOf<P>> = {
  params: PathParams<P> & Record<string, string>;
  query: Route<P, M>["query"];
  body: Route<P, M>["body"];
  req: FastifyRequest;
  reply: FastifyReply;
  /** The project for `{workspace_id}` routes. */
  project: () => Project;
};
type Result<T> = T | Promise<T>;

const NUMERIC = new Set(["version", "after", "limit"]);
function coerce(query: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query ?? {})) out[k] = v === "true" ? true : v === "false" ? false : NUMERIC.has(k) && /^\d+$/.test(v) ? Number(v) : v;
  return out;
}

export function router(app: FastifyInstance, reg: Registry) {
  return function route<P extends ApiPath, M extends MethodsOf<P>>(
    method: M, path: P, ...rest: [schema: z.ZodType | null, handler: (i: Input<P, M>) => Result<Route<P, M>["res"]>] | [handler: (i: Input<P, M>) => Result<Route<P, M>["res"]>]
  ) {
    const [schema, handler] = rest.length === 2 ? rest : [null, rest[0]];
    app.route({
      method, url: path.replace(/\{(\w+)\}/g, ":$1"),
      handler: async (req, reply) => {
        const params = req.params as PathParams<P> & Record<string, string>;
        let body = req.body as Route<P, M>["body"];
        if (schema) {
          const parsed = schema.safeParse(req.body ?? {});
          if (!parsed.success) {
            reply.code(422);
            return { detail: parsed.error.issues.map((i) => ({ loc: ["body", ...i.path.map(String)], msg: i.message })) };
          }
          body = parsed.data as Route<P, M>["body"];
        }
        return handler({ params, query: coerce(req.query as Record<string, string>) as Route<P, M>["query"], body, req, reply,
          project: () => {
            if (!params.workspace_id) throw new UserError("Missing project", 400);
            return project(reg, params.workspace_id);
          } });
      },
    });
  };
}
export type RouteFn = ReturnType<typeof router>;
