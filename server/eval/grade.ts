/**
 * Grades a finished project. The project is copied to a temporary folder, the task's hidden/ grader is copied in beside
 * it, and the grader runs there. The grader prints one JSON line with its checks. The folder the agent worked in never
 * holds hidden/, so the agent cannot read the expected behavior.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
export const TASKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "tasks");

const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  grader: z.discriminatedUnion("run", [
    z.object({ run: z.literal(true) }),
    z.object({ run: z.literal(false), reason: z.string().min(1) }),
  ]),
});
export type TaskSpec = z.infer<typeof TaskSchema>;

const GraderOutputSchema = z.object({
  checks: z.array(z.object({ name: z.string(), pass: z.boolean(), detail: z.string().optional() })),
});
export interface Check { name: string; pass: boolean; detail?: string }
/** `pass` is null when the grader did not run. `reason` says why. */
export interface Grade { graded: boolean; pass: boolean | null; checks: Check[]; reason?: string }

export function listTasks(): string[] {
  return readdirSync(TASKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function loadTask(id: string): TaskSpec {
  const file = path.join(TASKS_DIR, id, "task.json");
  if (!existsSync(file)) throw new Error(`Unknown eval task "${id}". Tasks: ${listTasks().join(", ")}`);
  const spec = TaskSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (spec.id !== id) throw new Error(`Task folder ${id} declares id ${spec.id}`);
  return spec;
}

/** The project's own files, without the engine's `.octopus` data or installed packages. */
const copyFilter = (src: string) => !/[\\/](\.octopus|node_modules)([\\/]|$)/.test(src);

function lastJsonLine(text: string): unknown {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  if (!line) return undefined;
  try { return JSON.parse(line); } catch { return undefined; }
}

export async function gradeProject(id: string, projectDir: string): Promise<Grade> {
  const task = loadTask(id);
  if (!task.grader.run) return { graded: false, pass: null, checks: [], reason: task.grader.reason };
  const work = mkdtempSync(path.join(tmpdir(), `octopus-grade-${id}-`));
  try {
    cpSync(projectDir, work, { recursive: true, filter: copyFilter });
    cpSync(path.join(TASKS_DIR, id, "hidden"), path.join(work, "hidden"), { recursive: true });
    let stdout = "";
    let stderr = "";
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, ["hidden/grade.mjs"], { cwd: work, timeout: 120_000, maxBuffer: 10_000_000 }));
    } catch (e) {
      const failed = e as { stdout?: string; stderr?: string; message: string };
      stdout = failed.stdout ?? "";
      stderr = failed.stderr ?? failed.message;
    }
    const parsed = GraderOutputSchema.safeParse(lastJsonLine(stdout));
    const checks: Check[] = parsed.success
      ? parsed.data.checks
      : [{ name: "grader produced its checks", pass: false, detail: stderr.split("\n")[0]?.slice(0, 300) || "no output" }];
    return { graded: true, pass: checks.length > 0 && checks.every((c) => c.pass), checks };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
