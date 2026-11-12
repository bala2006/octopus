/**
 * The project file boundary. Every path from an agent or the browser goes through `ProjectFs.resolve`, which rejects
 * absolute paths, `..`, symlinks that leave the folder, and Octopus/Git internals. Listing skips dependency and build
 * folders so agents see the project, not its caches.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { UserError } from "../lib/util";

export const WORK_DIR = ".octopus/work";
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage",
  ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "target", ".gradle", ".idea", ".vscode",
  ".playwright-mcp", ".dart_tool", "Pods",
]);
const SECRET = /(^|\/)(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|class|exe|dll|so|dylib|o|a|wasm|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|ogg|wav|sqlite|db|bin)$/i;

export const isSecretPath = (rel: string) => SECRET.test(rel) && !/\.(example|sample|template)$/i.test(rel);
export const isBinaryPath = (rel: string) => BINARY.test(rel);

export type Actor = "agent" | "user";

export class ProjectFs {
  readonly root: string;
  constructor(root: string) { this.root = realpathSync(root); }

  /** Normalise a project-relative path ("" is the root). Throws a UserError when it is not allowed. */
  rel(input: string, actor: Actor = "agent"): string {
    const raw = String(input ?? "").replace(/\\/g, "/").trim();
    if (raw.includes("\0")) throw new UserError("Invalid path");
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new UserError(`Use a path relative to the project, not ${raw}`);
    const norm = path.posix.normalize(raw || ".").replace(/^\.\//, "").replace(/\/$/, "");
    if (norm === ".." || norm.startsWith("../")) throw new UserError(`${raw} is outside the project`);
    const top = norm.split("/")[0]!.toLowerCase();
    if (top === ".git") throw new UserError("The .git folder is managed by Git; use Git commands instead");
    if (top === ".octopus" && !(actor === "agent" && (norm === WORK_DIR || norm.startsWith(`${WORK_DIR}/`)))) {
      // the exact spelling matters: on case-insensitive disks ".Octopus/work" would still be the private folder
      throw new UserError(actor === "agent" ? `.octopus is private; use ${WORK_DIR}/ for working notes` : ".octopus is managed by Octopus");
    }
    return norm === "." ? "" : norm;
  }

  /** Absolute path for a project-relative path, after checking that no symlink leads outside the project. */
  abs(input: string, actor: Actor = "agent"): string {
    const rel = this.rel(input, actor);
    const full = path.join(this.root, rel);
    const inside = (p: string) => p === this.root || p.startsWith(this.root + path.sep);
    // Check every symlink on the way, including dangling ones (writing through them would create the target).
    let cur = this.root;
    for (const part of rel ? rel.split("/") : []) {
      cur = path.join(cur, part);
      let st;
      try { st = lstatSync(cur); } catch { break; }
      if (st.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(cur); } catch { target = path.resolve(path.dirname(cur), readlinkSync(cur)); }
        if (!inside(target)) throw new UserError(`${input} leads outside the project`);
      }
    }
    return full;
  }

  toRel(abs: string): string { return path.relative(this.root, abs).split(path.sep).join("/"); }

  exists(rel: string, actor: Actor = "agent") { try { return existsSync(this.abs(rel, actor)); } catch { return false; } }

  /** Walk files (project-relative paths), skipping ignored folders. `.octopus/work` is included for agents. */
  walk(opts: { base?: string; max?: number; actor?: Actor; folders?: boolean } = {}): { files: string[]; folders: string[]; truncated: boolean } {
    const max = opts.max ?? 5000;
    const files: string[] = [];
    const folders: string[] = [];
    const visit = (dirRel: string): boolean => {
      let entries;
      try { entries = readdirSync(path.join(this.root, dirRel), { withFileTypes: true }); } catch { return true; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          if (rel === ".octopus") {
            if (opts.actor === "agent" && existsSync(path.join(this.root, WORK_DIR))) { folders.push(".octopus", WORK_DIR); if (!visit(WORK_DIR)) return false; }
            continue;
          }
          folders.push(rel);
          if (!visit(rel)) return false;
        } else if (e.isFile()) {
          if (files.length >= max) return false;
          files.push(rel);
        }
      }
      return true;
    };
    const base = opts.base ? this.rel(opts.base, opts.actor) : "";
    const complete = visit(base);
    return { files, folders, truncated: !complete };
  }

  size(rel: string, actor: Actor = "agent"): number { try { return statSync(this.abs(rel, actor)).size; } catch { return 0; } }
  isDir(rel: string): boolean { try { return lstatSync(this.abs(rel)).isDirectory(); } catch { return false; } }
}
