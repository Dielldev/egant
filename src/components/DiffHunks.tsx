import hljs from "highlight.js/lib/common";
import { useMemo } from "react";
import type { DiffHunk, DiffLine } from "../lib/types";

/** Unified reads as one column with markers; split puts the two sides beside
 * each other. Remembered across tabs, because it is a preference about reading
 * diffs, not about this file. */
export type DiffStyle = "unified" | "split";

/** One row of a split diff: what each side shows on the same line. A context
 * line is the same line on both. */
interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/** Pairs a hunk's lines into rows: runs of removals line up against the runs
 * of additions that replaced them, and context lands on both sides. */
function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];

  const flush = () => {
    const height = Math.max(removed.length, added.length);
    for (let i = 0; i < height; i += 1) rows.push({ left: removed[i], right: added[i] });
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line.origin === "-") removed.push(line);
    else if (line.origin === "+") added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

/** Every hunk of one file's diff, in whichever style is in force.
 *
 * Shared by the stage's diff tabs and the panel's Diffs pane, which are two
 * places to read the same thing and must read the same way — a line that wraps
 * in one and scrolls in the other is two answers to one question.
 *
 * `wrap` decides whether a long line folds onto the next row or runs off to
 * the right. Off by default: code is written in lines, and a wrapped diff
 * makes two files of different line lengths hard to compare side by side. */
export function DiffHunks({
  hunks,
  language,
  style,
  wrap = false,
}: {
  hunks: DiffHunk[];
  language: string | null;
  style: DiffStyle;
  wrap?: boolean;
}) {
  return (
    <>
      {hunks.map((hunk, index) =>
        style === "unified" ? (
          <UnifiedHunk key={index} hunk={hunk} language={language} wrap={wrap} />
        ) : (
          <SplitHunk key={index} hunk={hunk} language={language} wrap={wrap} />
        ),
      )}
    </>
  );
}

function HunkHeader({ header }: { header: string }) {
  return <div className="code-hunk-header">{header}</div>;
}

function UnifiedHunk({
  hunk,
  language,
  wrap,
}: {
  hunk: DiffHunk;
  language: string | null;
  wrap: boolean;
}) {
  return (
    <div className="flex flex-col">
      <HunkHeader header={hunk.header} />
      <div className="flex flex-col">
        {hunk.lines.map((line, index) => (
          <div key={index} className={`code-diff-row ${toneFor(line.origin)}`}>
            <span className="code-diff-num">{line.oldLineno ?? ""}</span>
            <span className="code-diff-num">{line.newLineno ?? ""}</span>
            <span className="code-diff-marker">{markerFor(line.origin)}</span>
            <Code text={line.content} language={language} wrap={wrap} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitHunk({
  hunk,
  language,
  wrap,
}: {
  hunk: DiffHunk;
  language: string | null;
  wrap: boolean;
}) {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk]);
  return (
    <div className="flex flex-col">
      <HunkHeader header={hunk.header} />
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-2">
          <Side line={row.left} side="left" language={language} wrap={wrap} />
          <Side line={row.right} side="right" language={language} wrap={wrap} />
        </div>
      ))}
    </div>
  );
}

/** One half of a split row. An absent line is the blank that keeps the two
 * sides level when one side is longer than the other. */
function Side({
  line,
  side,
  language,
  wrap,
}: {
  line?: DiffLine;
  side: "left" | "right";
  language: string | null;
  wrap: boolean;
}) {
  if (!line) return <div className="code-diff-row code-diff-blank" />;
  // A context line is the same line on both sides, so it is never tinted; an
  // edit is only ever a removal on the left or an addition on the right.
  const tone = line.origin === " " ? "" : side === "left" ? toneFor("-") : toneFor("+");
  return (
    <div className={`code-diff-row ${tone}`}>
      <span className="code-diff-num">
        {(side === "left" ? line.oldLineno : line.newLineno) ?? ""}
      </span>
      <Code text={line.content} language={language} wrap={wrap} />
    </div>
  );
}

export function toneFor(origin: string): string {
  if (origin === "+") return "code-diff-add";
  if (origin === "-") return "code-diff-del";
  return "";
}

function markerFor(origin: string): string {
  return origin === "+" || origin === "-" ? origin : " ";
}

/** One line of code, highlighted on its own. A line at a time loses the
 * context a whole-file parse has — a string spanning three lines colours only
 * where it opens — but a diff hands out fragments, not files, and per-line is
 * what keeps it honest about what it can know. */
function Code({
  text,
  language,
  wrap,
}: {
  text: string;
  language: string | null;
  wrap: boolean;
}) {
  const html = useMemo(() => {
    const body = text.replace(/\n$/, "");
    if (!language) return escapeHtml(body);
    try {
      return hljs.highlight(body, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(body);
    }
  }, [text, language]);
  return (
    <span
      className={`code-pane code-diff-text ${wrap ? "code-wrap" : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
