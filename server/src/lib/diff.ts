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
