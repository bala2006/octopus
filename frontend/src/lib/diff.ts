export interface DiffLine { kind: "add" | "del" | "ctx"; text: string; a?: number; b?: number }

/** Minimal LCS line diff (fine for files up to a few thousand lines). */
export function lineDiff(oldText: string, newText: string, maxLines = 4000): DiffLine[] {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText.split("\n");
  if (a.length > maxLines || b.length > maxLines) return b.map((t, i) => ({ kind: "add", text: t, b: i + 1 }));
  const m = a.length, n = b.length;
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ kind: "ctx", text: a[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: "del", text: a[i], a: i + 1 }); i++; }
    else { out.push({ kind: "add", text: b[j], b: j + 1 }); j++; }
  }
  while (i < m) { out.push({ kind: "del", text: a[i], a: i + 1 }); i++; }
  while (j < n) { out.push({ kind: "add", text: b[j], b: j + 1 }); j++; }
  return out;
}

/** Collapse unchanged runs to `context` lines around changes. */
export function hunks(lines: DiffLine[], context = 3): Array<DiffLine | { kind: "gap"; count: number }> {
  const keep = new Set<number>();
  lines.forEach((l, idx) => { if (l.kind !== "ctx") for (let k = idx - context; k <= idx + context; k++) keep.add(k); });
  const out: Array<DiffLine | { kind: "gap"; count: number }> = [];
  let gap = 0;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) { if (gap) { out.push({ kind: "gap", count: gap }); gap = 0; } out.push(l); } else gap++;
  });
  if (gap) out.push({ kind: "gap", count: gap });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length };
}
