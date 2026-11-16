/**
 * The transcript of one solo conversation, kept at `.octopus/sessions/<conversation>.jsonl`. The first line holds the
 * metadata: the model, the head length, the last runtime context, the rules files sent and whether the skill catalog was sent.
 * Each later line is one transcript item. Items are appended as they arrive. The file is rewritten whole only when earlier content changed, such as after a compaction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Item } from "../llm/azure";

export interface SessionMeta {
  model: string;
  /** Leading items that compaction never replaces: the runtime context and the first request. */
  head: number;
  /** The runtime context last written, without the project overview; null before the first one. */
  context: string | null;
  /** Whether the skill catalog is in the transcript. It is sent once per session. */
  catalog: boolean;
  /** The sha1 of each project rules file as the transcript last sent it. */
  rules: Record<string, string>;
}

/** Cuts a transcript back to its last finished step, so no tool call is left without its output. Returns the length to keep. */
export function trimToFinishedStep(items: Item[]): number {
  const open = new Set<string>();
  let keep = 0;
  items.forEach((item, i) => {
    if (item.type === "function_call") open.add(item.call_id);
    else if (item.type === "function_call_output") open.delete(item.call_id);
    if (open.size === 0) keep = i + 1;
  });
  return keep;
}

const sameMeta = (a: SessionMeta, b: SessionMeta) => a.model === b.model && a.head === b.head && a.context === b.context && a.catalog === b.catalog
  && JSON.stringify(a.rules) === JSON.stringify(b.rules);

export class SessionLog {
  /** The items the file holds now, so a save appends only what is new. */
  private written: Item[] = [];
  private meta: SessionMeta | null = null;

  constructor(readonly file: string) {}

  /**
   * The stored transcript, or null when there is none. Reasoning items are dropped when the model changed, since the
   * model cannot read the reasoning another model wrote.
   */
  load(model: string): { meta: SessionMeta; items: Item[] } | null {
    if (!existsSync(this.file)) return null;
    let meta: SessionMeta | null = null;
    const items: Item[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: Item;
      try { entry = JSON.parse(line); } catch { continue; } // a line cut short by a crash
      if (entry.type === "meta") meta = { model: entry.model, head: entry.head, context: entry.context ?? null, catalog: entry.catalog ?? false, rules: entry.rules ?? {} };
      else items.push(entry);
    }
    if (!meta) return null;
    this.meta = meta;
    this.written = [...items];
    return { meta, items: meta.model === model ? items : items.filter((item) => item.type !== "reasoning") };
  }

  /** Brings the file in line with the transcript: appends new items, or rewrites the file when earlier content changed. */
  save(meta: SessionMeta, items: Item[]) {
    const kept = this.meta !== null && sameMeta(this.meta, meta) && items.length >= this.written.length
      && this.written.every((item, i) => items[i] === item);
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!kept) {
      const text = [{ type: "meta", ...meta }, ...items].map((entry) => `${JSON.stringify(entry)}\n`).join("");
      writeFileSync(`${this.file}.tmp`, text);
      renameSync(`${this.file}.tmp`, this.file);
    } else if (items.length > this.written.length) {
      appendFileSync(this.file, items.slice(this.written.length).map((item) => `${JSON.stringify(item)}\n`).join(""));
    }
    this.meta = { ...meta };
    this.written = [...items];
  }
}
