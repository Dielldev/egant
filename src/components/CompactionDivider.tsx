import { FoldVertical } from "lucide-react";
import { formatTokens } from "../lib/transcript";
import type { Entry } from "../lib/types";

/** Where the agent summarized the conversation to make room in its context
 * window, drawn across the transcript the way Claude Code marks it ("✻
 * Conversation compacted"). Everything above the line still reads here in
 * full, but now reaches the model only as a summary — which is also why the
 * context meter just dropped. The figures are in the tooltip: they explain
 * the drop, but aren't worth a line of their own in the conversation. */
export function CompactionDivider({
  entry,
  className = "text-[11px]",
}: {
  entry: Extract<Entry, { kind: "compaction" }>;
  /** The text size; the phone draws it larger. */
  className?: string;
}) {
  const before = `The conversation had filled ${formatTokens(entry.tokensBefore)} tokens of context.`;
  const after =
    entry.tokensAfter != null
      ? ` Everything above this line now reaches the agent as a summary of about ${formatTokens(entry.tokensAfter)}.`
      : " Everything above this line now reaches the agent as a summary.";
  return (
    <div
      role="separator"
      title={`${before}${after}`}
      className={`flex w-full items-center gap-3 text-[var(--faint)] select-none ${className}`}
    >
      <span className="h-px flex-1 bg-[var(--border)]" />
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <FoldVertical size={12} strokeWidth={2} className="shrink-0" />
        {entry.auto ? "Conversation compacted automatically" : "Conversation compacted"}
      </span>
      <span className="h-px flex-1 bg-[var(--border)]" />
    </div>
  );
}
