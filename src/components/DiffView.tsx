import hljs from "highlight.js/lib/common";
import { useMemo } from "react";
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One diff line, syntax-colored in the file's language — the same per-line
 * highlighting the stage diff viewer uses (`DiffHunks`), so a dropdown diff
 * reads like the file it edits. A line at a time loses multi-line token
 * context, but a diff hands out fragments, not files. */
function HighlightedLine({ line, language }: { line: string; language: string | null }) {
  const html = useMemo(() => {
    if (!language) return escapeHtml(line);
    try {
      return hljs.highlight(line, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(line);
    }
  }, [line, language]);
  return <code className="diff-hl min-w-0 flex-1" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A git-diff-style line view: green `+` for additions, red `-` for
 * removals, plain for unchanged context. Used by the Edit/MultiEdit tool
 * card — one `DiffView` per edit. Lines highlight in the edited file's
 * language, like the file viewer. */
export function DiffView({
  oldText,
  newText,
  language = null,
}: {
  oldText: string;
  newText: string;
  language?: string | null;
}) {
  const parts = diffLines(capForDiff(oldText), capForDiff(newText));

  return (
    <div className="max-h-[320px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] font-mono text-[11px] leading-5">
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
            <HighlightedLine line={line} language={language} />
          </div>
        )),
      )}
    </div>
  );
}

/** The Write tool's body: there's no "old" side, so every line of the new
 * file renders as an addition — numbered 1..N and highlighted in the file's
 * language, like the file viewer. */
export function AddedLinesView({
  text,
  language = null,
}: {
  text: string;
  language?: string | null;
}) {
  const lines = chunkLines(capForDiff(text));
  return (
    <div className="max-h-[320px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className="flex bg-[var(--diff-add-bg)] px-2 whitespace-pre text-[var(--diff-add-fg)]"
        >
          <span className="w-8 shrink-0 pr-2 text-right opacity-60 select-none">
            {index + 1}
          </span>
          <span className="w-3 shrink-0 opacity-60 select-none">+</span>
          <HighlightedLine line={line} language={language} />
        </div>
      ))}
    </div>
  );
}
