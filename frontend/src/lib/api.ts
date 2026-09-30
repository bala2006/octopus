/** Typed REST client generated from the backend OpenAPI schema (openapi-typescript + openapi-fetch). */
import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "@/types/api.gen";

export const TOKEN_KEY = "octopus-token";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const auth: Middleware = {
  onRequest({ request }) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) request.headers.set("Authorization", `Bearer ${token}`);
    return request;
  },
};

export const api = createClient<paths>({ baseUrl: "" });
api.use(auth);

function detailOf(err: unknown, status: number): string {
  if (err && typeof err === "object" && "detail" in err) {
    const d = (err as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x: { msg?: string; loc?: unknown[] }) => `${x.loc?.slice(-1)[0] ?? ""}: ${x.msg ?? ""}`).join("; ");
  }
  return status === 0 ? "Network error: is the Octopus backend running?" : `Request failed (${status})`;
}

/** Unwrap an openapi-fetch result, throwing ApiError with the server's detail message. */
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

/** Raw fetch for non-JSON endpoints (markdown, zip). */
export async function fetchRaw(url: string, init?: RequestInit): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
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
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) q.set("token", token);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return `${proto}://${location.host}${path}${q.size ? `?${q}` : ""}`;
}
