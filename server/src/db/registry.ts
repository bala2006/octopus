/**
 * The registry: one database per user in OCTOPUS_HOME. It knows which project folders exist and holds settings that
 * apply everywhere (model connection, approval mode, MCP servers, custom roles, skills and team templates).
 */
import path from "node:path";
import type { CanvasExport, McpToolOut, RoleTemplateOut, SkillOut } from "@octopus/shared";
import { config } from "../config";
import { Db } from "./sqlite";

const MIGRATIONS = [
  `CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_opened_at TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL, command TEXT NOT NULL DEFAULT '',
     args TEXT NOT NULL DEFAULT '[]', url TEXT NOT NULL DEFAULT '', env_enc TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
     tools TEXT NOT NULL DEFAULT '[]', last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
   CREATE TABLE user_templates (key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE user_roles (key TEXT PRIMARY KEY, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
   CREATE TABLE user_skills (name TEXT PRIMARY KEY, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`,
];

export type WorkspaceRow = { id: string; name: string; path: string; created_at: string; last_opened_at: string };
export type McpRow = {
  id: string; name: string; transport: "stdio" | "http"; command: string; args: string[]; url: string; env_enc: string;
  enabled: boolean; tools: McpToolOut[]; last_error: string; updated_at: string;
};
export type TemplateRow = { key: string; name: string; description: string; spec: CanvasExport; updated_at: string };
export type RoleRow = { key: string; data: Omit<RoleTemplateOut, "source">; deleted: boolean; updated_at: string };
export type SkillRow = { name: string; data: Omit<SkillOut, "source">; deleted: boolean; updated_at: string };

export function openRegistry(file = path.join(config.home, "registry.db")) {
  const db = new Db(file, MIGRATIONS);
  const settingsTable = db.table<{ key: string; value: unknown }>("settings", { key: "key", json: ["value"] });
  return {
    db,
    workspaces: db.table<WorkspaceRow>("workspaces"),
    mcp: db.table<McpRow>("mcp_servers", { json: ["args", "tools"], bool: ["enabled"] }),
    templates: db.table<TemplateRow>("user_templates", { key: "key", json: ["spec"] }),
    roles: db.table<RoleRow>("user_roles", { key: "key", json: ["data"], bool: ["deleted"] }),
    skills: db.table<SkillRow>("user_skills", { key: "name", json: ["data"], bool: ["deleted"] }),
    setting<T>(key: string, fallback: T): T {
      return (settingsTable.get(key)?.value as T | undefined) ?? fallback;
    },
    setSetting(key: string, value: unknown) { settingsTable.upsert({ key, value }); },
    deleteSetting(key: string) { settingsTable.remove(key); },
  };
}
export type Registry = ReturnType<typeof openRegistry>;
