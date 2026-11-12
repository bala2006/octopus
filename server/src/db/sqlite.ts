/**
 * A thin layer over Node's built-in SQLite: schema migrations by `user_version`, and a typed table helper that maps
 * JSON and boolean columns, so the rest of the server works with plain objects.
 */
import { mkdirSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as SqliteDb, SQLInputValue } from "node:sqlite";
import path from "node:path";

// Loaded with require: bundlers used by the test runner do not know the node:sqlite builtin yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Row = Record<string, unknown>;
type Param = SQLInputValue | boolean | undefined;

export class Db {
  readonly raw: SqliteDb;

  constructor(file: string, migrations: string[]) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    // Databases from Octopus 1.x (Python, Alembic) have a different schema: keep them aside and start fresh.
    if (this.get("SELECT name FROM sqlite_master WHERE name = 'alembic_version'")) {
      this.raw.close();
      renameSync(file, file.replace(/\.db$/, `.v1-${Date.now()}.db`));
      this.raw = new DatabaseSync(file);
    }
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const version = Number((this.get<{ user_version: number }>("PRAGMA user_version"))?.user_version ?? 0);
    migrations.slice(version).forEach((sql, i) => this.tx(() => {
      this.raw.exec(sql);
      this.raw.exec(`PRAGMA user_version = ${version + i + 1}`);
    }));
  }

  private bind(params: Param[]): SQLInputValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  }
  run(sql: string, ...params: Param[]) { return this.raw.prepare(sql).run(...this.bind(params)); }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined { return this.raw.prepare(sql).get(...this.bind(params)) as T | undefined; }
  all<T = Row>(sql: string, ...params: Param[]): T[] { return this.raw.prepare(sql).all(...this.bind(params)) as T[]; }

  private depth = 0;
  tx<T>(fn: () => T): T {
    const outer = this.depth === 0;
    if (outer) this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (outer) this.raw.exec("COMMIT");
      return result;
    } catch (e) {
      this.depth--;
      if (outer) this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  close() { this.raw.close(); }

  table<T extends object>(name: string, spec: { key?: string; json?: (keyof T)[]; bool?: (keyof T)[] } = {}) {
    return new Table<T>(this, name, spec.key ?? "id", new Set(spec.json as string[] ?? []), new Set(spec.bool as string[] ?? []));
  }
}

export class Table<T extends object> {
  constructor(private db: Db, readonly name: string, private key: string, private json: Set<string>, private bool: Set<string>) {}

  private decode = (row: Row | undefined): T | undefined => {
    if (!row) return undefined;
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = this.json.has(k) ? (v == null ? null : JSON.parse(String(v))) : this.bool.has(k) ? !!v : v;
    }
    return out as T;
  };
  private encode(value: unknown, column: string): Param {
    if (this.json.has(column)) return value === undefined ? undefined : JSON.stringify(value);
    return value as Param;
  }

  get(id: string): T | undefined { return this.decode(this.db.get(`SELECT * FROM ${this.name} WHERE ${this.key} = ?`, id)); }
  /** Rows matching `where` (an SQL fragment with `?` placeholders); ordered by `order`. */
  find(where = "1=1", params: Param[] = [], order = "rowid"): T[] {
    return this.db.all<Row>(`SELECT * FROM ${this.name} WHERE ${where} ORDER BY ${order}`, ...params).map((r) => this.decode(r)!);
  }
  one(where: string, params: Param[] = []): T | undefined { return this.find(where, params)[0]; }
  insert(row: T): T {
    const r = row as Row;
    const cols = Object.keys(r).filter((k) => r[k] !== undefined);
    this.db.run(`INSERT INTO ${this.name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, ...cols.map((c) => this.encode(r[c], c)));
    return row;
  }
  upsert(row: T): T {
    const r = row as Row;
    const cols = Object.keys(r).filter((k) => r[k] !== undefined);
    const updates = cols.filter((c) => c !== this.key).map((c) => `${c} = excluded.${c}`).join(",");
    this.db.run(`INSERT INTO ${this.name} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT(${this.key}) DO UPDATE SET ${updates}`,
      ...cols.map((c) => this.encode(r[c], c)));
    return row;
  }
  update(id: string, patch: Partial<T>): T | undefined {
    const p = patch as Row;
    const cols = Object.keys(p).filter((k) => p[k] !== undefined && k !== this.key);
    if (cols.length) this.db.run(`UPDATE ${this.name} SET ${cols.map((c) => `${c} = ?`).join(",")} WHERE ${this.key} = ?`, ...cols.map((c) => this.encode(p[c], c)), id);
    return this.get(id);
  }
  remove(id: string) { this.db.run(`DELETE FROM ${this.name} WHERE ${this.key} = ?`, id); }
  removeWhere(where: string, params: Param[] = []) { this.db.run(`DELETE FROM ${this.name} WHERE ${where}`, ...params); }
  count(where = "1=1", params: Param[] = []): number {
    return Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${this.name} WHERE ${where}`, ...params)?.n ?? 0);
  }
}
