/**
 * Prints the median and the range of each measure per task and mode, and the pass rate per mode, from the result files
 * that `run.ts` writes. Reads every `*.jsonl` in eval-results/ unless `--file` names one.
 *
 *   npm run eval:report -w server -- --file eval-results/<sha>-pipeline.jsonl
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RESULTS_DIR, RowSchema, type Row } from "./run";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const range = (xs: number[]) => `${Math.min(...xs)}-${Math.max(...xs)}`;

export function readRows(files: string[]): Row[] {
  return files.flatMap((file) =>
    readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => RowSchema.parse(JSON.parse(line))));
}

export function report(rows: Row[]): string {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.task} ${row.mode}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = ["task             mode      runs  pass  calls (median, range)  input tokens (median, range)  wall s (median, range)"];
  for (const [key, group] of [...groups].sort()) {
    const graded = group.filter((r) => r.pass !== null);
    const passRate = graded.length ? `${graded.filter((r) => r.pass).length}/${graded.length}` : "not run";
    const calls = group.map((r) => r.model_calls);
    const input = group.map((r) => r.input_tokens);
    const wall = group.map((r) => r.wall_s);
    const [task, mode] = key.split(" ");
    lines.push(`${task!.padEnd(16)} ${mode!.padEnd(9)} ${String(group.length).padStart(4)}  ${passRate.padStart(4)}  ` +
      `${median(calls)} (${range(calls)})`.padEnd(22) + `  ${median(input)} (${range(input)})`.padEnd(30) +
      `  ${median(wall).toFixed(1)} (${Math.min(...wall).toFixed(1)}-${Math.max(...wall).toFixed(1)})`);
  }
  const modes = [...new Set(rows.map((r) => r.mode))];
  for (const mode of modes) {
    const graded = rows.filter((r) => r.mode === mode && r.pass !== null);
    const passed = graded.filter((r) => r.pass).length;
    lines.push(`pass rate ${mode}: ${graded.length ? `${passed}/${graded.length}` : "no graded runs"}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { file: { type: "string" } }, strict: true });
  const files = values.file
    ? [path.resolve(values.file)]
    : readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(RESULTS_DIR, f));
  if (files.length === 0) throw new Error(`No result files in ${RESULTS_DIR}. Run npm run eval first.`);
  console.log(report(readRows(files)));
}

