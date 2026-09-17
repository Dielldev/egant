import { elapsedLabel, statusVerb } from "../lib/transcript";
import type { TurnState } from "../lib/types";
import { LogoLoader } from "./Logo";
import { useNow } from "./useNow";

/** How wide the mark sits in the line. The artwork is 622×456, so this lands
 * it ~14px tall, inside the line box the row's 12px text already occupies —
 * the glyph slots in without the row growing taller when a turn starts. */
const GLYPH_W = 20;

/** The live status line under the conversation: the app's mark, a shimmering
 * word, and the turn's own clock. It is deliberately passive — no button, no
 * dismissal — and it stays put from the moment the user hits send until the
 * turn settles, so there is never a stretch of the wait with nothing on screen
 * accounting for it. The transcript above it says *what* happened; this says
 * the turn is still alive, and for how long. */
export function StatusLine({
  state,
  startedAt,
}: {
  state: TurnState;
  /** When this turn started, per the transcript fold. */
  startedAt: number | null;
}) {
  // Twice a second: the clock only shows whole seconds, but sampling on the
  // second would let the displayed count lag a full one behind.
  const now = useNow(500);

  const elapsed = startedAt == null ? 0 : Math.max(0, now - startedAt);
  // Nothing is being computed while a permission prompt is up, so the line
  // says so rather than cycling words as if work were happening.
  const waiting = state === "awaiting_permission";
  const label = waiting ? "Waiting on you" : statusVerb(startedAt ?? 0, elapsed);

  return (
    <div className="flex min-w-0 items-center gap-2 py-1 pl-0.5 text-xs select-none">
      {/* The mark and the word run the same wave off the same keyframes, and
        they mount together, so the two stay in phase — one gesture across the
        row rather than two indicators competing. The word beside it is the
        accessible name for both, so the mark stays decorative. */}
      <LogoLoader width={GLYPH_W} />
      {/* Floored width, so a longer word rotating in doesn't shove the clock
        and the hint sideways every few seconds — wide enough for the longest
        verb in the list at this size. */}
      <span
        className={`min-w-[100px] whitespace-nowrap ${waiting ? "text-[var(--muted)]" : "shimmer"}`}
      >
        {label}…
      </span>
      <span className="tabular-nums text-[var(--faint)]">{elapsedLabel(elapsed)}</span>
      <span className="truncate text-[var(--faint)]">· ⌘⎋ to interrupt</span>
    </div>
  );
}
