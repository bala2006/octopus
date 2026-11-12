/** Recoverable deletes: files and folders move to `.octopus/trash/<token>/` instead of being removed. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TrashedItem } from "@octopus/shared";
import { newId, UserError } from "../lib/util";
import type { Actor, ProjectFs } from "../safety/paths";

const dir = (fs: ProjectFs) => path.join(fs.root, ".octopus", "trash");

function sizeOf(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((n, name) => n + sizeOf(path.join(p, name)), 0);
}

/** Move a file or folder to the trash and return its restore token. */
export function trash(fs: ProjectFs, rel: string, actor: Actor): string {
  const from = fs.abs(rel, actor);
  if (!existsSync(from)) throw new UserError(`${rel} does not exist`, 404);
  if (!fs.rel(rel, actor)) throw new UserError("The project folder itself cannot be deleted");
  const token = `${Date.now().toString(36)}-${newId().slice(0, 6)}`;
  const target = path.join(dir(fs), token);
  mkdirSync(target, { recursive: true });
  const st = statSync(from);
  const item: TrashedItem = { token, path: fs.rel(rel, actor), kind: st.isDirectory() ? "folder" : "file", size: sizeOf(from), deleted_at: Date.now() / 1000 };
  try { renameSync(from, path.join(target, "payload")); } catch {
    cpSync(from, path.join(target, "payload"), { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
  writeFileSync(path.join(target, "item.json"), JSON.stringify(item));
  return token;
}

export function listTrash(fs: ProjectFs): TrashedItem[] {
  if (!existsSync(dir(fs))) return [];
  return readdirSync(dir(fs)).flatMap((token) => {
    try { return [JSON.parse(readFileSync(path.join(dir(fs), token, "item.json"), "utf8")) as TrashedItem]; } catch { return []; }
  }).sort((a, b) => b.deleted_at - a.deleted_at);
}

export function restore(fs: ProjectFs, token: string): TrashedItem {
  if (!/^[\w-]+$/.test(token)) throw new UserError("Invalid token");
  const item = listTrash(fs).find((t) => t.token === token);
  if (!item) throw new UserError("That item is no longer in the trash", 404);
  const to = fs.abs(item.path, "user");
  if (existsSync(to)) throw new UserError(`${item.path} already exists; move it away first`, 409);
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(path.join(dir(fs), token, "payload"), to);
  rmSync(path.join(dir(fs), token), { recursive: true, force: true });
  return item;
}
