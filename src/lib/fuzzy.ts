// Fuzzy matching for the composer's `/` and `@` menus: the letters typed, in
// order, anywhere in the name — `tvw` finds `TranscriptView.tsx` — ranked so
// the match a person meant comes first.

/** Where a match counts for more: the start of the text, or of a word in it
 * (after `/`, `-`, `_`, `.`, a space, or at a lower-to-upper case step). */
function wordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1]!;
  if ("/-_. :".includes(before)) return true;
  return before === before.toLowerCase() && text[index] !== text[index]!.toLowerCase();
}

/** How well `query` matches `text` as an in-order subsequence, ignoring case,
 * or `null` when it doesn't. Higher is better: letters in a row, letters at
 * word starts and letters in the last path segment (the file's own name)
 * count for more, and a shorter text wins a tie. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase();
  if (needle === "") return 0;
  const hay = text.toLowerCase();
  const nameStart = text.lastIndexOf("/") + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of needle) {
    const at = hay.indexOf(char, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 4;
    if (wordStart(text, at)) score += 3;
    if (at >= nameStart) score += 2;
    previous = at;
    from = at + 1;
  }
  // The whole name typed out beats the same letters spread across a path.
  if (hay.slice(nameStart).startsWith(needle)) score += 8;
  return score - text.length * 0.01;
}

/** The items matching `query`, best first, at most `limit` of them. An empty
 * query keeps the items' own order. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit: number,
): T[] {
  if (query.trim() === "") return items.slice(0, limit);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(query.trim(), key(item));
    if (score != null) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}
