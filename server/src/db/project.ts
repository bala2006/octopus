/**
 * The project database at `<folder>/.octopus/octopus.db`: the company (agents and channels), conversations, their
 * messages, tasks, event log, file versions and agent memory. Rows have the same shape as the wire types.
 */
import path from "node:path";
import type {
  AgentOut, ArtifactOut, DepartmentInfo, EdgeOut, MemoryOut, MessageOut, RunBudget, RunDetail, SessionOut, TaskOut,
} from "@octopus/shared";
import { Db } from "./sqlite";

const MIGRATIONS = [
  `CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', departments TEXT NOT NULL DEFAULT '{}',
     viewport TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE agents (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '',
     is_entry INTEGER NOT NULL DEFAULT 0, is_manager INTEGER NOT NULL DEFAULT 0, reports_to TEXT, avatar TEXT NOT NULL DEFAULT 'bot',
     color TEXT NOT NULL DEFAULT '#66839A', model TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT 'azure', temperature REAL NOT NULL DEFAULT 0.4,
     max_tokens INTEGER NOT NULL DEFAULT 32000, position_x REAL NOT NULL DEFAULT 0, position_y REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
     tools TEXT NOT NULL DEFAULT '{}', behavior TEXT NOT NULL DEFAULT '{}', created_by TEXT);
   CREATE INDEX agents_company ON agents(company_id);
   CREATE TABLE edges (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, source_agent_id TEXT NOT NULL,
     target_agent_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'delegate', label TEXT NOT NULL DEFAULT '', bidirectional INTEGER NOT NULL DEFAULT 0,
     config TEXT NOT NULL DEFAULT '{}');
   CREATE INDEX edges_company ON edges(company_id);
   CREATE TABLE sessions (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, agent_id TEXT, mode TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE runs (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, session_id TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
     budget TEXT NOT NULL, permission_level TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', halt_reason TEXT NOT NULL DEFAULT '',
     report_md TEXT NOT NULL DEFAULT '', tokens_used INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
     outcome TEXT, snapshot TEXT NOT NULL, state TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT);
   CREATE TABLE messages (id TEXT PRIMARY KEY, run_id TEXT, session_id TEXT, edge_id TEXT, from_agent_id TEXT, to_agent_id TEXT, sender TEXT NOT NULL,
     type TEXT NOT NULL, content TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', turn_no INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
   CREATE INDEX messages_run ON messages(run_id);
   CREATE INDEX messages_session ON messages(session_id);
   CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
     acceptance_criteria TEXT NOT NULL DEFAULT '', assignee_agent_id TEXT, status TEXT NOT NULL, kind TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
     result TEXT NOT NULL DEFAULT '', created_by TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
   CREATE INDEX tasks_run ON tasks(run_id);
   CREATE TABLE run_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, ts TEXT NOT NULL);
   CREATE INDEX run_events_run ON run_events(run_id, seq);
   CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL, version INTEGER NOT NULL, content TEXT,
     author_agent_id TEXT, change_note TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
   CREATE INDEX artifacts_path ON artifacts(path, version);
   CREATE INDEX artifacts_run ON artifacts(run_id);
   CREATE TABLE memory (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id, key));`,
];

export type CompanyRow = {
  id: string; name: string; description: string; departments: Record<string, DepartmentInfo>;
  viewport: Record<string, number> | null; revision: number; created_at: string; updated_at: string;
};
export type RunRow = Omit<RunDetail, "budget" | "outcome"> & { budget: RunBudget; outcome: RunDetail["outcome"] };
/** `created`: this version brought the file into existence (agents may keep editing files they created). */
export type ArtifactRow = ArtifactOut & { content: string | null; created: boolean };
export type EventRow = { seq: number; run_id: string; type: string; data: unknown; ts: string };
/** Agent id used for notes every agent in the project can read. */
export const SHARED_MEMORY = "*";

export function openProject(root: string) {
  const db = new Db(path.join(root, ".octopus", "octopus.db"), MIGRATIONS);
  // A process that stopped mid-conversation leaves it "running"; it can be continued, so show it as paused.
  db.run("UPDATE runs SET status = 'paused', halt_reason = 'Octopus was restarted' WHERE status IN ('running', 'queued')");
  return {
    db,
    root,
    tx: <T>(fn: () => T) => db.tx(fn),
    companies: db.table<CompanyRow>("companies", { json: ["departments", "viewport"] }),
    agents: db.table<AgentOut>("agents", { json: ["tools", "behavior"], bool: ["is_entry", "is_manager", "active"] }),
    edges: db.table<EdgeOut>("edges", { json: ["config"], bool: ["bidirectional"] }),
    sessions: db.table<SessionOut>("sessions"),
    runs: db.table<RunRow>("runs", { json: ["budget", "outcome", "snapshot", "state"] }),
    messages: db.table<MessageOut>("messages", { json: ["meta"] }),
    tasks: db.table<TaskOut>("tasks", { json: ["depends_on"] }),
    events: db.table<EventRow>("run_events", { key: "seq", json: ["data"] }),
    artifacts: db.table<ArtifactRow>("artifacts", { bool: ["deleted", "created"] }),
    memory: db.table<MemoryOut>("memory"),
  };
}
export type ProjectDb = ReturnType<typeof openProject>;
