/**
 * The changed lines of one file, for a reviewer: the lines between the first and last difference, "-" for removed and
 * "+" for added. A new file is all added; a deleted file is all removed.
 */
export function changedLines(before: string | null, after: string | null): { text: string; lines: number } {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const removed = a.slice(start, endA).map((l) => `-${l}`);
  const added = b.slice(start, endB).map((l) => `+${l}`);
  return { text: [...removed, ...added].join("\n"), lines: removed.length + added.length };
}

/** A review brief holds the whole diff up to this many characters. Above it, the brief lists each file with its line count. */
export const BRIEF_DIFF_LIMIT = 60_000;

export interface FileDiff { file: string; text: string; lines: number }

/**
 * The diff a review brief shows. Each changed file comes with its changed lines while the whole stays within the limit.
 * Above the limit, the brief lists the changed files with their line counts, and the reviewer reads the files it needs.
 */
export function briefDiff(files: FileDiff[], limit = BRIEF_DIFF_LIMIT): string {
  const changed = files.filter((f) => f.lines > 0);
  if (!changed.length) return "No file changed.";
  const whole = changed.map((f) => `### ${f.file} (${f.lines} changed lines)\n${f.text}`).join("\n\n");
  if (whole.length <= limit) return whole;
  return [
    `The diff is over ${limit} characters. Changed files, with their changed lines:`,
    ...changed.map((f) => `- ${f.file}: ${f.lines} changed lines`),
  ].join("\n");
}
