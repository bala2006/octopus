/**
 * How much checking a change gets. The tier follows what the change touches: a one-line edit to one file has nothing a
 * second reviewer would find, while a change to authentication, dependencies or build configuration, or a change the
 * user asked to be checked against requirements, does.
 *
 *   trivial  one file, a few lines, nothing sensitive: no review. The owner's own verification is the record.
 *   small    a little code and no requirements: one review, from the diff alone.
 *   normal   requirements to check, configuration or dependencies, or a larger change: one reviewer.
 *   high     specialists attached to the part, a sensitive path, or a large change: every critic attached.
 *
 * Acceptance is not decided here: it runs for requirements that are still open or unmet, at every tier above trivial.
 * A request with requirements is never trivial, so the router never skips a check the user asked for.
 */

export type Tier = "trivial" | "small" | "normal" | "high";

export interface Footprint {
  /** Project-relative paths the part changed. */
  files: string[];
  /** Changed lines since the part's last review. */
  lines: number;
  /** Specialists the lead attached to the part. */
  specialists: number;
  /** Requirements of the request that are still open or unmet. */
  requirements: number;
  /** The part was sent back by review: a fix is checked again, however small, because its findings are answered only by a check. */
  revised: boolean;
}

/** Words in a path that mark code where a mistake costs the most. Whole words only: `authors.md` is not `auth`. */
const SENSITIVE_WORDS = new Set([
  "auth", "login", "session", "password", "passwd", "token", "secret", "secrets", "credential", "credentials", "crypto",
  "permission", "permissions", "payment", "payments", "billing", "migration", "migrations", "schema", "security", "env",
  "docker", "dockerfile", "github", "workflows",
]);
/** Dependency manifests, lock files and build or tool configuration. */
const CONFIG = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements[^/]*\.txt|Pipfile(\.lock)?|tsconfig[^/]*\.json|(vite|webpack|next|rollup|jest|vitest)\.config\.[cm]?[jt]s|\.nvmrc|Makefile)$/i;

export const isSensitivePath = (file: string): boolean => file.toLowerCase().split(/[^a-z0-9]+/).some((w) => SENSITIVE_WORDS.has(w));

export function tierOf(f: Footprint): Tier {
  if (f.specialists > 0 || f.files.length > 8 || f.lines > 400 || f.files.some(isSensitivePath)) return "high";
  if (f.requirements > 0 || f.files.length > 2 || f.lines > 80 || f.files.some((x) => CONFIG.test(x))) return "normal";
  if (f.revised || f.files.length > 1 || f.lines > 20) return "small";
  return "trivial";
}
