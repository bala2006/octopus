/**
 * Typed REST client over the shared route map (`@octopus/shared` ApiRoutes): paths, parameters, bodies and responses
 * are checked at compile time against the same types the server is written against.
 */
import type { ApiPath, ApiRoutes, Method, MethodsOf, PathParams, Route } from "@octopus/shared";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

type Options<P extends ApiPath, M extends MethodsOf<P>> =
  (PathParams<P> extends undefined ? { params?: { query?: Route<P, M>["query"] } } : { params: { path: PathParams<P>; query?: Route<P, M>["query"] } })
  & (Route<P, M>["body"] extends undefined ? { body?: undefined } : { body: Route<P, M>["body"] })
  & { signal?: AbortSignal };
type Result<T> = Promise<{ data?: T; error?: unknown; response: Response }>;
type Caller<M extends Method> = <P extends { [K in ApiPath]: M extends keyof ApiRoutes[K] ? K : never }[ApiPath]>(
  path: P, ...opts: PathParams<P> extends undefined ? [Options<P, M & MethodsOf<P>>?] : [Options<P, M & MethodsOf<P>>]
) => Result<Route<P, M & MethodsOf<P>>["res"]>;

function url(path: string, params?: { path?: Record<string, string>; query?: Record<string, unknown> }): string {
  let out = path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params?.path?.[k] ?? ""));
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params?.query ?? {})) if (v !== undefined && v !== null) q.set(k, String(v));
  if (q.size) out += `?${q}`;
  return out;
}

function request(method: Method) {
  return (async (path: string, opts?: { params?: { path?: Record<string, string>; query?: Record<string, unknown> }; body?: unknown; signal?: AbortSignal }) => {
    const response = await fetch(url(path, opts?.params), {
      method,
      signal: opts?.signal,
      headers: opts?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await response.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
    return response.ok ? { data: json, response } : { error: json ?? {}, response };
  }) as unknown as Caller<typeof method>;
}

export const api = {
  GET: request("GET") as Caller<"GET">,
  POST: request("POST") as Caller<"POST">,
  PUT: request("PUT") as Caller<"PUT">,
  PATCH: request("PATCH") as Caller<"PATCH">,
  DELETE: request("DELETE") as Caller<"DELETE">,
};

function detailOf(err: unknown, status: number): string {
  if (err && typeof err === "object" && "detail" in err) {
    const d = (err as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x: { msg?: string; loc?: unknown[] }) => `${x.loc?.slice(-1)[0] ?? ""}: ${x.msg ?? ""}`).join("; ");
  }
  return status === 0 ? "Network error: is the Octopus server running?" : `Request failed (${status})`;
}

/** Unwrap a client result, throwing ApiError with the server's message. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let res;
  try {
    res = await p;
  } catch {
    throw new ApiError(0, detailOf(null, 0));
  }
  if (res.error !== undefined || !res.response.ok) throw new ApiError(res.response.status, detailOf(res.error, res.response.status), res.error);
  return res.data as T;
}

/** Raw fetch for downloads, uploads and other non-JSON endpoints. */
export async function fetchRaw(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, detailOf(body, res.status), body);
  }
  return res;
}

export function wsUrl(path: string, params: Record<string, string | number | undefined> = {}): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return `${proto}://${location.host}${path}${q.size ? `?${q}` : ""}`;
}
