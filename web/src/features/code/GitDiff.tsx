import { cn } from "@/lib/utils";

/** A unified patch, with additions, removals, and hunk headers colored. */
export function GitDiff({
  patch,
  loading,
  error,
  untracked,
}: {
  patch: string | undefined;
  loading: boolean;
  error: string | undefined;
  untracked: boolean;
}) {
  if (loading) return <p className="p-4 text-xs text-muted-foreground">Loading patch…</p>;
  if (error) return <p role="alert" className="p-4 text-xs text-destructive">{error}</p>;
  if (!patch) {
    return (
      <p className="p-4 text-xs leading-relaxed text-muted-foreground">
        {untracked
          ? "This file is not tracked yet. Stage it to include it in the next commit, or open it to read its contents."
          : "No changes in this view."}
      </p>
    );
  }
  return (
    <pre className="min-w-max py-2 font-mono text-[12px] leading-5">
      {patch.split("\n").map((line, i) => (
        <span key={i} className={cn("block whitespace-pre px-4", lineTone(line))}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function lineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-muted-foreground";
  }
  if (line.startsWith("+")) return "bg-success/10 text-success";
  if (line.startsWith("-")) return "bg-destructive/10 text-destructive";
  if (line.startsWith("@@")) return "bg-sky-400/10 text-sky-400";
  return "text-foreground/80";
}
