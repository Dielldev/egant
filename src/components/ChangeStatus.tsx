import { SquareArrowRight, SquareDot, SquareMinus, SquarePlus, SquareX } from "lucide-react";
import type { GitChangeStatus } from "../lib/types";

/** What git did to a path, as one glyph. A new file reads as an addition
 * whether or not it has been staged yet — untracked is a fact about the index,
 * not about the change, and the row already says which section it is in. */
export function ChangeStatusIcon({
  status,
  size = 16,
}: {
  status: GitChangeStatus;
  size?: number;
}) {
  const props = { size, strokeWidth: 1.9, className: "shrink-0" } as const;
  switch (status) {
    case "added":
    case "untracked":
      return <SquarePlus {...props} color="var(--diff-add-fg)" />;
    case "modified":
      return <SquareDot {...props} color="var(--diff-mod-fg)" />;
    case "deleted":
      return <SquareMinus {...props} color="var(--diff-del-fg)" />;
    case "renamed":
      return <SquareArrowRight {...props} color="var(--faint)" />;
    case "conflicted":
      return <SquareX {...props} color="var(--diff-conflict-fg)" />;
  }
}

/** `999` stays `999`, `1000` becomes `999+`: the column is narrow and the
 * exact size of a very large change is not what the number is for. */
export function formatDiffLineCount(count: number): string {
  return count > 999 ? "999+" : String(count);
}

/** The `+12 −3` beside a row. Silent when a change has no lines either way,
 * which is what a binary file or a pure rename looks like. */
export function DiffLineStats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span
      aria-label={`${additions} lines added, ${deletions} lines removed`}
      className="flex shrink-0 items-center gap-1 text-[12px] leading-none tabular-nums"
    >
      {additions > 0 && (
        <span className="text-[var(--diff-add-fg)]">+{formatDiffLineCount(additions)}</span>
      )}
      {deletions > 0 && (
        <span className="text-[var(--diff-del-fg)]">−{formatDiffLineCount(deletions)}</span>
      )}
    </span>
  );
}

/** A path split the way every row here shows it: the filename carries the
 * weight, the directory trails behind it in the quiet colour. */
export function splitPath(path: string): { filename: string; directory: string } {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { filename: path, directory: "" };
  return { filename: path.slice(cut + 1), directory: path.slice(0, cut) };
}
