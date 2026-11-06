import { fetchRaw } from "@/lib/api";
import { parseObject, parseText } from "./apiParsers";

export type MemoryScope = "agent" | "group" | "chat" | "project";
export type MemoryClassification =
  "proposed" | "verified" | "superseded" | "deleted";
export type MemorySource = {
  kind: "memory" | "message" | "artifact";
  id: string;
};
export interface MemoryNote {
  id: string;
  key: string;
  version: number;
  scope: MemoryScope;
  scope_id: string;
  run_id: string | null;
  content: string;
  classification: MemoryClassification;
  pinned: boolean;
  source_refs: MemorySource[];
}
export interface MemoryGroup {
  id: string;
  name: string;
  members: string[];
  active: boolean;
}
export interface MemoryWrite {
  scope: MemoryScope;
  scope_id: string;
  run_id: string | null;
  key: string;
  content: string;
  expected_version: number;
  sources: MemorySource[];
  classification: MemoryClassification;
  pinned: boolean;
  share_sources: boolean;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing memory identity");
  return value;
}
function scope(value: unknown): MemoryScope {
  switch (value) {
    case "agent":
    case "group":
    case "chat":
    case "project":
      return value;
    default:
      throw new Error("Unknown memory scope");
  }
}
function classification(value: unknown): MemoryClassification {
  switch (value) {
    case "proposed":
    case "verified":
    case "superseded":
    case "deleted":
      return value;
    default:
      throw new Error("Unknown memory classification");
  }
}
function source(value: unknown): MemorySource {
  const item = parseObject(value, "Invalid memory response");
  switch (item.kind) {
    case "memory":
    case "message":
    case "artifact":
      return { kind: item.kind, id: string(item.id) };
    default:
      throw new Error("Unknown source type");
  }
}
export function parseMemory(value: unknown): MemoryNote {
  const item = parseObject(value, "Invalid memory response");
  if (
    typeof item.version !== "number" ||
    !Number.isInteger(item.version) ||
    item.version < 1 ||
    !Array.isArray(item.source_refs) ||
    typeof item.pinned !== "boolean"
  )
    throw new Error("Invalid memory version");
  return {
    id: string(item.id),
    key: string(item.key),
    version: item.version,
    scope: scope(item.scope),
    scope_id: string(item.scope_id),
    run_id: item.run_id == null ? null : string(item.run_id),
    content: string(item.content),
    classification: classification(item.classification),
    pinned: item.pinned,
    source_refs: item.source_refs.map(source),
  };
}
function parseGroup(value: unknown): MemoryGroup {
  const item = parseObject(value, "Invalid memory response");
  if (!Array.isArray(item.members) || typeof item.active !== "boolean")
    throw new Error("Invalid sharing group");
  return {
    id: string(item.id),
    name: string(item.name),
    active: item.active,
    members: item.members.map(string),
  };
}
function endpoint(
  workspace: string,
  company: string,
  suffix = "",
  extra?: URLSearchParams,
): string {
  const query = new URLSearchParams(extra);
  query.set("company_id", company);
  return `/api/v1/w/${encodeURIComponent(workspace)}/memory${suffix}?${query}`;
}
async function json(
  path: string,
  method?: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetchRaw(
    path,
    method
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  return response.status === 204 ? null : response.json();
}
export const memoryKey = (workspace: string, company: string) => [
  "scoped-memory",
  workspace,
  company,
];
export async function listMemory(
  workspace: string,
  company: string,
  runId?: string,
) {
  const query = new URLSearchParams({ limit: "200", include_proposed: "true" });
  if (runId) query.set("run_id", runId);
  const response = await json(endpoint(workspace, company, "", query));
  if (!Array.isArray(response)) throw new Error("Invalid memory list");
  return response.map(parseMemory);
}
export async function exactMemory(
  workspace: string,
  company: string,
  id: string,
) {
  return parseMemory(
    await json(endpoint(workspace, company, `/${encodeURIComponent(id)}`)),
  );
}
export async function writeMemory(
  workspace: string,
  company: string,
  value: MemoryWrite,
) {
  return parseMemory(await json(endpoint(workspace, company), "PUT", value));
}
export async function listMemoryGroups(workspace: string, company: string) {
  const response = await json(endpoint(workspace, company, "/groups"));
  if (!Array.isArray(response)) throw new Error("Invalid group list");
  return response.map(parseGroup);
}
export async function saveMemoryGroup(
  workspace: string,
  company: string,
  value: { name: string; members: string[] },
  id?: string,
) {
  return json(
    endpoint(
      workspace,
      company,
      id ? `/groups/${encodeURIComponent(id)}` : "/groups",
    ),
    id ? "PATCH" : "POST",
    value,
  );
}
export async function archiveMemoryGroup(
  workspace: string,
  company: string,
  id: string,
) {
  return json(
    endpoint(workspace, company, `/groups/${encodeURIComponent(id)}`),
    "DELETE",
  );
}
export async function exactSource(
  workspace: string,
  company: string,
  ref: MemorySource,
) {
  const item = parseObject(
    await json(
      endpoint(
        workspace,
        company,
        `/sources/${ref.kind}/${encodeURIComponent(ref.id)}`,
      ),
    ),
    "Invalid memory response",
  );
  return {
    id: string(item.id),
    content: string(item.content),
    label: parseText(item.label, `${ref.kind}:${ref.id}`),
    truncated: item.truncated === true,
  };
}
