/**
 * A tool result longer than the limit is saved in full under the project's work folder. The model gets the first and
 * last characters and the path, so it can read the middle in line ranges, and the transcript stays small.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORK_DIR, type ProjectFs } from "../safety/paths";

export const SPILL_OVER = 40_000;
const EDGE = 20_000;

export function spill(fs: ProjectFs, callId: string, text: string): { text: string; path: string | null } {
  if (text.length <= SPILL_OVER) return { text, path: null };
  const rel = `${WORK_DIR}/spill/${callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`;
  const abs = path.join(fs.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  const hidden = text.length - 2 * EDGE;
  return {
    path: rel,
    text: `${text.slice(0, EDGE)}\n\n… [${hidden} characters not shown. The full output is saved at ${rel}. Read it with read_file and offset and limit, for example offset 1 and limit 400.]\n\n${text.slice(-EDGE)}`,
  };
}
