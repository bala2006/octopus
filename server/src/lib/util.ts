/** Small helpers used everywhere on the server. */
import { randomUUID, createHash } from "node:crypto";

export const newId = (): string => randomUUID().replace(/-/g, "").slice(0, 16);
export const now = (): string => new Date().toISOString();
export const sha1 = (s: string | Buffer): string => createHash("sha1").update(s).digest("hex");
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shorten text for prompts and logs, keeping the start and the end. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  return `${text.slice(0, head)}\n… [${text.length - max} characters omitted] …\n${text.slice(text.length - (max - head))}`;
}

export function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

/** An error whose message is safe and useful to show the user; `status` becomes the HTTP status. */
export class UserError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const notFound = (what: string) => new UserError(`${what} not found`, 404);

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "item";
}

/** A promise you can resolve from outside (approvals, user answers). */
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
