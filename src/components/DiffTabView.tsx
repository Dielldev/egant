import { AlignJustify, Columns2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import type { DiffHunk } from "../lib/types";
import type { StageTab } from "../store";
import { useEgant } from "../store";
import type { DiffStyle } from "./DiffHunks";
import { DiffHunks } from "./DiffHunks";
import { isImage, languageFor, previewKind, PreviewPane } from "./FileView";
import { FileIcon } from "./FileIcon";
import { useEditorFontSize } from "./SettingsKit";

export type { DiffStyle };

const STYLE_KEY = "egant.diffStyle";

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
  // The tab carries what it is a diff of. `undefined` is the working tree,
  // where the group still picks which of its two sides to show.
  const scope = tab.scope ?? { kind: "workingTree" as const, staged: tab.group === "staged" };
  // `scope` is a fresh object every render; what the fetch depends on is the
  // comparison it names (including `staged` / `base` / `session` / `sha`).
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .diffFile(root, tab.path, scope)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, tab.path, tab.group, scopeKey, changesToken]);

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
  const workingTree = scope.kind === "workingTree";
  const staged = workingTree && scope.staged;
  // What each side of this diff is, in the terms `blob_data_url` uses: an
  // unstaged diff is the index against what is on disk; a staged one is HEAD
  // against the index.
  const before = staged ? "head" : "index";
  const after = staged ? "index" : "workdir";
  const preview = previewKind(tab.name);
  // Rendered views read blobs from the index, HEAD or the disk — the three
  // places `blob_data_url` knows. A branch, a turn or a commit is measured
  // from a tree that is none of them, so those scopes show the text diff and
  // say so rather than rendering the wrong side of the comparison.
  const image = isImage(tab.name) && workingTree;

  if (image) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <DiffToolbar
          label={scopeLabel(tab)}
          name={tab.name}
          path={tab.path}
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
        label={scopeLabel(tab)}
        name={tab.name}
        path={tab.path}
        style={style}
        onStyle={chooseStyle}
        onRefresh={() => refreshChanges()}
        showStyle={mode === "diff"}
        preview={preview !== null && workingTree}
        mode={mode}
        onMode={setMode}
      />

      {mode === "preview" && preview && workingTree ? (
        <DiffPreview root={root} path={tab.path} source={after} kind={preview} token={changesToken} />
      ) : error ? (
        <Centered text={error} danger />
      ) : loading && hunks === null ? (
        <Centered text="Reading…" />
      ) : empty ? (
        <Centered text={emptyText(tab, staged)} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto pb-3">
          <DiffHunks hunks={hunks ?? []} language={language} style={style} />
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

function Centered({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <span className={`text-xs ${danger ? "text-[var(--danger)]" : "text-[var(--faint)]"}`}>
        {text}
      </span>
    </div>
  );
}

/** What a diff tab is showing, for the strip above it. */
function scopeLabel(tab: StageTab): string {
  switch (tab.group) {
    case "staged":
      return "Staged";
    case "branch":
      return "Branch changes";
    case "turn":
      return "Latest turn";
    case "commit":
      return `Commit ${(tab.scope?.kind === "commit" ? tab.scope.sha : "").slice(0, 7)}`;
    default:
      return "Changed";
  }
}

/** Why there is nothing to show, in the terms of whatever was being compared. */
function emptyText(tab: StageTab, staged: boolean): string {
  switch (tab.group) {
    case "branch":
      return "This branch has not touched this file";
    case "turn":
      return "This turn has not touched this file";
    case "commit":
      return "This commit did not change this file";
    default:
      return staged ? "Nothing staged for this file" : "No unstaged changes to this file";
  }
}

/** The strip above a diff: which file it is on the left, and how to
 * read it on the right. Mirrors the toolbar emdash puts over its diff editor. */
function DiffToolbar({
  label,
  name,
  path,
  style,
  onStyle,
  onRefresh,
  showStyle,
  preview = false,
  mode = "diff",
  onMode,
}: {
  /** What this diff is of — the side of git, or the comparison it came from. */
  label: string;
  /** The file under diff, shown with its language icon like the file reader. */
  name?: string;
  path?: string;
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
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {name && <FileIcon name={name} size={14} />}
        {name && (
          <span title={path ?? name} className="shrink-0 truncate text-[12px] font-medium text-[var(--ink)]">
            {name}
          </span>
        )}
        <span className="shrink-0 truncate text-[11px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
          {label}
        </span>
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
