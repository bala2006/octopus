/**
 * Syntax check for a file an agent just wrote or edited. The result names the first errors with their lines, so the agent
 * fixes a broken file in the next step instead of finding out in a failing run. The file is kept either way.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { transform } from "esbuild";

const execFileAsync = promisify(execFile);
const MAX_ERRORS = 5;
type Loader = "ts" | "tsx" | "js" | "jsx" | "json";
const ESBUILD_LOADERS: Record<string, Loader> = {
  ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".mjs": "js", ".cjs": "js",
};
/** Compiles the file named by argv[1] without writing a .pyc next to it, so a check leaves no files in the project. */
const PYTHON_CHECK = "import py_compile, os, sys; py_compile.compile(sys.argv[1], cfile=os.devnull, doraise=True)";

interface SyntaxProblem { line: number | null; message: string }

async function esbuildProblems(content: string, loader: Loader): Promise<SyntaxProblem[]> {
  try {
    await transform(content, { loader, logLevel: "silent" });
    return [];
  } catch (e) {
    const errors = (e as { errors?: { text: string; location: { line: number } | null }[] }).errors;
    if (!errors?.length) throw e;
    return errors.map((m) => ({ line: m.location?.line ?? null, message: m.text }));
  }
}

async function jsonProblems(content: string): Promise<SyntaxProblem[]> {
  try {
    JSON.parse(content);
    return [];
  } catch (e) {
    // Not every runtime says where a JSON error is, so esbuild places it when it can.
    const placed = await esbuildProblems(content, "json");
    return placed.length ? placed : [{ line: null, message: (e as Error).message }];
  }
}

let python: string | null | undefined;
/** The first Python on the path that runs, or null when there is none. Looked up once per process. */
async function pythonCommand(): Promise<string | null> {
  if (python !== undefined) return python;
  python = null;
  for (const candidate of ["python", "python3"]) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 5_000 });
      python = candidate;
      break;
    } catch { /* not on the path: try the next name */ }
  }
  return python;
}

async function pythonProblems(abs: string): Promise<SyntaxProblem[]> {
  const cmd = await pythonCommand();
  if (!cmd) return [];
  try {
    await execFileAsync(cmd, ["-c", PYTHON_CHECK, abs], { timeout: 10_000 });
    return [];
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? "");
    const lines = stderr.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    const line = /line (\d+)/.exec(stderr);
    return [{ line: line ? Number(line[1]) : null, message: lines.at(-1) ?? "does not compile" }];
  }
}

async function problemsIn(rel: string, abs: string, content: string): Promise<SyntaxProblem[]> {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") return jsonProblems(content);
  if (ext === ".py") return pythonProblems(abs);
  const loader = ESBUILD_LOADERS[ext];
  return loader ? esbuildProblems(content, loader) : [];
}

/**
 * The note to add to a write or edit result: empty when the file parses or has a type this checks, otherwise the first
 * five problems with their lines.
 */
export async function syntaxNote(rel: string, abs: string, content: string): Promise<string> {
  let problems: SyntaxProblem[];
  try {
    problems = await problemsIn(rel, abs, content);
  } catch {
    // The write has already happened, so a checker that cannot run adds no note rather than failing the tool.
    return "";
  }
  if (!problems.length) return "";
  const listed = problems.slice(0, MAX_ERRORS).map((p) => (p.line === null ? `  ${p.message}` : `  line ${p.line}: ${p.message}`));
  return `\nSyntax errors in ${rel}. Fix them before you go on:\n${listed.join("\n")}`;
}
