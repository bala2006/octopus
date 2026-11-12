/**
 * The run event log. Every event is written to the project database (except streaming deltas) and then delivered to
 * live subscribers, so a socket that reconnects replays from its last `seq` and never misses anything.
 */
import { EPHEMERAL_TOPICS, type RunEventEnvelope, type RunEventMap, type RunTopic } from "@octopus/shared";
import type { ProjectDb } from "../db/project";
import { now } from "../lib/util";

type Listener = (e: RunEventEnvelope) => void;
const listeners = new Map<string, Set<Listener>>();

export function publish<T extends RunTopic>(db: ProjectDb, runId: string, type: T, data: RunEventMap[T]): RunEventEnvelope<T> {
  const ts = now();
  const env: RunEventEnvelope<T> = { type, run_id: runId, data, ts };
  if (!EPHEMERAL_TOPICS.has(type)) {
    const r = db.db.run("INSERT INTO run_events (run_id, type, data, ts) VALUES (?, ?, ?, ?)", runId, type, JSON.stringify(data), ts);
    env.seq = Number(r.lastInsertRowid);
  }
  for (const l of listeners.get(runId) ?? []) {
    try { l(env); } catch { /* a broken socket must not break the run */ }
  }
  return env;
}

export function subscribe(runId: string, listener: Listener): () => void {
  const set = listeners.get(runId) ?? new Set();
  set.add(listener);
  listeners.set(runId, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(runId); };
}

export function replay(db: ProjectDb, runId: string, afterSeq: number, limit = 100_000): RunEventEnvelope[] {
  return db.events.find("run_id = ? AND seq > ?", [runId, afterSeq], "seq").slice(0, limit)
    .map((r) => ({ type: r.type as RunTopic, run_id: runId, data: r.data as never, seq: r.seq, ts: r.ts, replay: true }));
}
