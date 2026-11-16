/**
 * The project's instruction files: AGENTS.md, CLAUDE.md and their .local variants at the project root. A solo conversation
 * sends them as user messages. The first message holds every file present, and a later message holds each file that
 * changed. A message is cut at 64 KB in all, and a message that was sent is never edited.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sha1 } from "../lib/util";

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"] as const;
/** The most text one rules message carries, in bytes. */
export const RULES_BYTES = 64 * 1024;

/** The sha1 of each rule file's full text as the conversation last sent it. A file that was not sent has no entry. */
export type RulesSent = Record<string, string>;

function readRuleFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of RULE_FILES) {
    const abs = path.join(root, name);
    if (existsSync(abs) && statSync(abs).isFile()) files.set(name, readFileSync(abs, "utf8"));
  }
  return files;
}

/** The text cut to `limit` bytes, with a note saying so. Cuts only between characters. */
function cutBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const kept = bytes.subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
  return `${kept}\n[Cut at 64 KB. The rest of this file is not shown.]`;
}

/**
 * The rules message for what changed since `sent`, or null when nothing did. It names each changed file with its new
 * text, and a removed file with a note. The message holds at most 64 KB of file text.
 */
export function rulesUpdate(root: string, sent: RulesSent): { message: string; sent: RulesSent } | null {
  const found = readRuleFiles(root);
  const current: RulesSent = Object.fromEntries([...found].map(([name, text]) => [name, sha1(text)]));
  const changed = RULE_FILES.filter((name) => (current[name] ?? null) !== (sent[name] ?? null));
  if (!changed.length) return null;
  const firstMessage = Object.keys(sent).length === 0;
  let budget = RULES_BYTES;
  const sections = changed.map((name) => {
    const text = found.get(name);
    if (text === undefined) return `## ${name}\n(Removed from the project. Ignore the version sent earlier.)`;
    const kept = cutBytes(text, budget);
    budget = Math.max(0, budget - Buffer.byteLength(kept));
    return `## ${name}\n${kept}`;
  });
  const intro = firstMessage
    ? "These are the project's instruction files. Follow them unless the user's messages say otherwise."
    : "Project instruction files changed. Each new text below replaces the version sent earlier. Follow the new text.";
  return { message: `<project-rules>\n${intro}\n\n${sections.join("\n\n")}\n</project-rules>`, sent: current };
}
