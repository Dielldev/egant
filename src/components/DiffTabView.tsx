import hljs from "highlight.js/lib/common";
import { AlignJustify, Columns2, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import type { DiffHunk, DiffLine } from "../lib/types";
import type { StageTab } from "../store";
import { useEgant } from "../store";
import { isImage, languageFor, previewKind, PreviewPane } from "./FileView";
import { useEditorFontSize } from "./SettingsKit";

/** Unified reads as one column with markers; split puts the two sides beside
 * each other. Remembered across tabs, because it is a preference about reading
 * diffs, not about this file. */
export type DiffStyle = "unified" | "split";

const STYLE_KEY = "egant.diffStyle";

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

/** A diff open as a tab on the stage. Fetched on open and again whenever the
 * working tree may have moved — a turn ending, or a stage/commit from the
 * panel — so what's on screen keeps up with the agent. */
export function DiffTabView({ tab }: { tab: StageTab }) {
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [style, setStyle] = useState<DiffStyle>(() =>
    localStorage.getItem(STYLE_KEY) === "split" ? "split" : "unified",
  );
  const [mode, setMode] = useState<"diff" | "preview">("diff");
  const changesToken = useEgant((s) => s.changesToken);
  const refreshChanges = useEgant((s) => s.refreshChanges);
  // Same setting as the file viewer — a diff is code too.
  const editorFontSize = useEditorFontSize();

  const root = tab.root ?? "";
  const staged = tab.group === "staged";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .diffFile(root, tab.path, staged)
      .then((result) => {
        if (cancelled) return;
        setHunks(result);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        setHunks(null);
        setError(problem instanceof Error ? problem.message : String(problem));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, tab.path, staged, changesToken]);

  const chooseStyle = (next: DiffStyle) => {
    setStyle(next);
    try {
      localStorage.setItem(STYLE_KEY, next);
    } catch {
      // Unavailable storage: the choice still holds for this window.
    }
  };

  const language = languageFor(tab.name);
  const empty = hunks !== null && hunks.length === 0;
  // What each side of this diff is, in the terms `blob_data_url` uses: an
  // unstaged diff is the index against what is on disk; a staged one is HEAD
  // against the index.
  const before = staged ? "head" : "index";
  const after = staged ? "index" : "workdir";
  const preview = previewKind(tab.name);
  const image = isImage(tab.name);

  if (image) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DiffToolbar
          staged={staged}
          style={style}
          onStyle={chooseStyle}
          onRefresh={() => refreshChanges()}
          showStyle={false}
        />
        <ImageDiff root={root} path={tab.path} before={before} after={after} token={changesToken} />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--editor-font-size": `${editorFontSize}px` } as CSSProperties}
    >
      <DiffToolbar
        staged={staged}
        style={style}
        onStyle={chooseStyle}
        onRefresh={() => refreshChanges()}
        showStyle={mode === "diff"}
        preview={preview !== null}
        mode={mode}
        onMode={setMode}
      />

      {mode === "preview" && preview ? (
        <DiffPreview root={root} path={tab.path} source={after} kind={preview} token={changesToken} />
      ) : error ? (
        <Centered text={error} danger />
      ) : loading && hunks === null ? (
        <Centered text="Reading…" />
      ) : empty ? (
        <Centered
          text={staged ? "Nothing staged for this file" : "No unstaged changes to this file"}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-3">
          {(hunks ?? []).map((hunk, index) =>
            style === "unified" ? (
              <UnifiedHunk key={index} hunk={hunk} language={language} />
            ) : (
              <SplitHunk key={index} hunk={hunk} language={language} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function StyleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-[5px] p-1 ${
        active
          ? "bg-[var(--selected)] text-[var(--ink)]"
          : "text-[var(--faint)] hover:text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

function HunkHeader({ header }: { header: string }) {
  return (
    <div className="code-hunk-header">{header}</div>
  );
}

function UnifiedHunk({ hunk, language }: { hunk: DiffHunk; language: string | null }) {
  return (
    <div className="flex flex-col">
      <HunkHeader header={hunk.header} />
      <div className="flex flex-col">
        {hunk.lines.map((line, index) => (
          <div key={index} className={`code-diff-row ${toneFor(line.origin)}`}>
            <span className="code-diff-num">{line.oldLineno ?? ""}</span>
            <span className="code-diff-num">{line.newLineno ?? ""}</span>
            <span className="code-diff-marker">{markerFor(line.origin)}</span>
            <Code text={line.content} language={language} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SplitHunk({ hunk, language }: { hunk: DiffHunk; language: string | null }) {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk]);
  return (
    <div className="flex flex-col">
      <HunkHeader header={hunk.header} />
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-2">
          <Side line={row.left} side="left" language={language} />
          <Side line={row.right} side="right" language={language} />
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
}: {
  line?: DiffLine;
  side: "left" | "right";
  language: string | null;
}) {
  if (!line) return <div className="code-diff-row code-diff-blank" />;
  // A context line is the same line on both sides, so it is never tinted; an
  // edit is only ever a removal on the left or an addition on the right.
  const tone =
    line.origin === " " ? "" : side === "left" ? toneFor("-") : toneFor("+");
  return (
    <div className={`code-diff-row ${tone}`}>
      <span className="code-diff-num">
        {(side === "left" ? line.oldLineno : line.newLineno) ?? ""}
      </span>
      <Code text={line.content} language={language} />
    </div>
  );
}

function toneFor(origin: string): string {
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
function Code({ text, language }: { text: string; language: string | null }) {
  const html = useMemo(() => {
    const body = text.replace(/\n$/, "");
    if (!language) return escapeHtml(body);
    try {
      return hljs.highlight(body, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(body);
    }
  }, [text, language]);
  return <span className="code-pane code-diff-text" dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function Centered({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <span className={`text-xs ${danger ? "text-[var(--danger)]" : "text-[var(--faint)]"}`}>
        {text}
      </span>
    </div>
  );
}

/** The strip above a diff: which side of git it is on the left, and how to
 * read it on the right. Mirrors the toolbar emdash puts over its diff editor. */
function DiffToolbar({
  staged,
  style,
  onStyle,
  onRefresh,
  showStyle,
  preview = false,
  mode = "diff",
  onMode,
}: {
  staged: boolean;
  style: DiffStyle;
  onStyle: (style: DiffStyle) => void;
  onRefresh: () => void;
  showStyle: boolean;
  /** Whether this file can be rendered as well as read. */
  preview?: boolean;
  mode?: "diff" | "preview";
  onMode?: (mode: "diff" | "preview") => void;
}) {
  return (
    <div className="flex h-[38px] shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4">
      <span className="min-w-0 truncate text-[11px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
        {staged ? "Staged" : "Changed"}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          title="Re-read from git"
          onClick={onRefresh}
          className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
        {preview && onMode && (
          <div className="flex items-center gap-0.5 rounded-md bg-[var(--card)] p-0.5">
            <ModeButton active={mode === "diff"} onClick={() => onMode("diff")}>
              Diff
            </ModeButton>
            <ModeButton active={mode === "preview"} onClick={() => onMode("preview")}>
              Preview
            </ModeButton>
          </div>
        )}
        {showStyle && (
          <div className="flex items-center gap-0.5 rounded-md bg-[var(--card)] p-0.5">
            <StyleButton
              label="Unified diff"
              active={style === "unified"}
              onClick={() => onStyle("unified")}
            >
              <AlignJustify size={14} strokeWidth={2} />
            </StyleButton>
            <StyleButton
              label="Split diff"
              active={style === "split"}
              onClick={() => onStyle("split")}
            >
              <Columns2 size={14} strokeWidth={2} />
            </StyleButton>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer rounded-[5px] px-2 py-0.5 text-[12px] ${
        active
          ? "bg-[var(--selected)] text-[var(--ink)]"
          : "text-[var(--faint)] hover:text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

/** Two pictures rather than two texts. A missing side is what an added or
 * deleted image looks like, and saying so beats an empty frame. */
function ImageDiff({
  root,
  path,
  before,
  after,
  token,
}: {
  root: string;
  path: string;
  before: "index" | "head";
  after: "index" | "workdir";
  token: number;
}) {
  const [sides, setSides] = useState<{ before: string | null; after: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.blobDataUrl(root, path, before), api.blobDataUrl(root, path, after)])
      .then(([oldSide, newSide]) => {
        if (!cancelled) {
          setSides({ before: oldSide, after: newSide });
          setError(null);
        }
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root, path, before, after, token]);

  if (error) return <Centered text={error} danger />;
  if (!sides) return <Centered text="Reading…" />;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-4">
      <ImageSide label={before === "head" ? "Committed" : "Staged"} src={sides.before} />
      <ImageSide label={after === "index" ? "Staged" : "On disk"} src={sides.after} />
    </div>
  );
}

function ImageSide({ label, src }: { label: string; src: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
        {label}
      </span>
      <div className="image-checker flex min-h-[120px] flex-1 items-center justify-center rounded-lg border border-[var(--border)] p-2">
        {src ? (
          <img src={src} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-[12px] text-[var(--faint)]">Not on this side</span>
        )}
      </div>
    </div>
  );
}

/** The rendered form of a file that has one, instead of its diff. */
function DiffPreview({
  root,
  path,
  source,
  kind,
  token,
}: {
  root: string;
  path: string;
  source: "index" | "workdir";
  kind: "markdown" | "html";
  token: number;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .blobText(root, path, source)
      .then((result) => {
        if (!cancelled) {
          setText(result ?? "");
          setError(null);
        }
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [root, path, source, token]);

  if (error) return <Centered text={error} danger />;
  if (text === null) return <Centered text="Reading…" />;
  return <PreviewPane text={text} kind={kind} />;
}
