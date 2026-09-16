import { diffLines } from "diff";

/** Diffing two 20KB+ strings client-side buys nothing visually — cap each
 * side before it reaches jsdiff. */
const DIFF_INPUT_CAP = 20_000;

function capForDiff(text: string): string {
  return text.length > DIFF_INPUT_CAP
    ? `${text.slice(0, DIFF_INPUT_CAP)}\n… ${text.length - DIFF_INPUT_CAP} more characters`
    : text;
}

/** Splits a diff chunk's value into its lines, dropping the trailing empty
 * string `split("\n")` leaves behind when the chunk ends in a newline. */
function chunkLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A git-diff-style line view: green `+` for additions, red `-` for
 * removals, plain for unchanged context. Used by the Edit/MultiEdit tool
 * card — one `DiffView` per edit. */
export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const parts = diffLines(capForDiff(oldText), capForDiff(newText));

  return (
    <div className="max-h-[240px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] font-mono text-[11px] leading-5">
      {parts.map((part, partIndex) =>
        chunkLines(part.value).map((line, lineIndex) => (
          <div
            key={`${partIndex}-${lineIndex}`}
            className={`flex px-2 whitespace-pre ${
              part.added
                ? "bg-[var(--diff-add-bg)] text-[var(--diff-add-fg)]"
                : part.removed
                  ? "bg-[var(--diff-del-bg)] text-[var(--diff-del-fg)]"
                  : "text-[var(--faint)]"
            }`}
          >
            <span className="w-3 shrink-0 opacity-60 select-none">
              {part.added ? "+" : part.removed ? "-" : ""}
            </span>
            {line}
          </div>
        )),
      )}
    </div>
  );
}

/** The Write tool's body: there's no "old" side, so every line of the new
 * file renders as an addition rather than diffing against an empty string. */
export function AddedLinesView({ text }: { text: string }) {
  const lines = chunkLines(capForDiff(text));
  return (
    <div className="max-h-[240px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className="flex bg-[var(--diff-add-bg)] px-2 whitespace-pre text-[var(--diff-add-fg)]"
        >
          <span className="w-3 shrink-0 opacity-60 select-none">+</span>
          {line}
        </div>
      ))}
    </div>
  );
}
