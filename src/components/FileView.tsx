import { ask } from "@tauri-apps/plugin-dialog";
import hljs from "highlight.js/lib/common";
import { Lock, RefreshCw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { dropDraft, peekDraft, setFileDirty, stashDraft, useDirtyFiles } from "../lib/editorDrafts";
import { getBase, saveFile, setBase } from "../lib/fileSaver";
import type { FileContent } from "../lib/types";
import { useEgant, workspaceRoot } from "../store";
import { CodeEditor } from "./CodeEditor";
import type { CodeEditorHandle } from "./CodeEditor";
import { FileIcon } from "./FileIcon";
import { Markdown } from "./Markdown";
import { useFilesSettings } from "./SettingsKit";

/** Extension to highlight.js language. Only the families the common bundle
 * actually registers — anything else falls through to plain text rather than
 * to an auto-detect guess that gets it wrong. */
const LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  rs: "rust",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
};

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "icns",
]);

/** Extension, lower case, without the dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Whether this is something to look at rather than read. */
export function isImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** What this file can be rendered as, if anything — the other half of the
 * Diff/Preview and Source/Preview toggles. */
export function previewKind(name: string): "markdown" | "html" | null {
  const extension = extensionOf(name);
  if (extension === "md" || extension === "mdx" || extension === "markdown") return "markdown";
  if (extension === "html" || extension === "htm") return "html";
  return null;
}

/** A file rendered rather than read. HTML goes into a fully sandboxed frame:
 * it is the project's own file, but a preview pane is no place to let a page
 * run scripts or reach anything. */
export function PreviewPane({ text, kind }: { text: string; kind: "markdown" | "html" }) {
  if (kind === "html") {
    return (
      <iframe
        title="Preview"
        sandbox=""
        srcDoc={text}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
      <div className="mx-auto w-full max-w-[735px]">
        <Markdown text={text} />
      </div>
    </div>
  );
}

/** The highlight.js language for a filename, or `null` when the pack has no
 * grammar for it — shared with the diff viewer, which highlights the same
 * languages a line at a time. */
export function languageFor(name: string): string | null {
  const dot = name.toLowerCase().lastIndexOf(".");
  if (dot < 0) return null;
  const language = LANGUAGE[name.toLowerCase().slice(dot + 1)];
  return language && hljs.getLanguage(language) ? language : null;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** How long after the last keystroke Autosave writes. Long enough that a
 * burst of typing is one save, short enough that the disk is never far behind. */
const AUTOSAVE_DELAY_MS = 800;

/** Why a file that opened cannot be edited, for the header chip. */
function readOnlyReason(content: FileContent): string {
  return content.truncated
    ? "Only the first 2 MB is loaded, so saving would cut the file short"
    : "Not valid UTF-8, so saving would change bytes you never touched";
}

/** A file open as a tab on the stage: an editor with line numbers, highlighted
 * in the app's own colors, following Settings > Files (text size, word wrap,
 * Autosave). Text that cannot survive being written back — binary, cut short,
 * not UTF-8 — opens read-only instead. The agent edits these files too, so a
 * save is refused if the file changed since it was read (see `fileSaver`), and
 * the view offers to reload or overwrite rather than choosing for the user. */
export function FileView({ path, name }: { path: string; name: string }) {
  const [content, setContent] = useState<FileContent | null>(null);
  // What the editor opens with. `version` is its `key`: a fresh read from disk
  // is a fresh editor, rather than text pushed into one that has its own undo
  // history and cursor.
  const [seed, setSeed] = useState<{ text: string; crlf: boolean; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloads, setReloads] = useState(0);
  const [mode, setMode] = useState<"source" | "preview">(() =>
    // A README is something to read; a config file is something to inspect.
    previewKind(name) === "markdown" ? "preview" : "source",
  );
  const [previewText, setPreviewText] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ conflict: boolean; message: string } | null>(null);
  const root = useEgant((s) => workspaceRoot(s.snapshot));
  const dirty = useDirtyFiles((s) => !!s.paths[path]);
  const preview = previewKind(name);
  const image = isImage(name);
  const settings = useFilesSettings();

  const editor = useRef<CodeEditorHandle>(null);
  const timer = useRef<number | undefined>(undefined);
  // Read at event time by handlers that outlive the render that made them.
  const live = useRef({ autosave: settings.autosave, conflict: false });
  live.current = { autosave: settings.autosave, conflict: problem?.conflict ?? false };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .readFile(path)
      .then((file) => {
        if (cancelled) return;
        setContent(file);
        // Edits from an earlier visit to this tab win over the disk: they are
        // what the user last saw. The save will still notice if the file has
        // moved on since.
        const draft = file.editable ? peekDraft(path) : undefined;
        if (draft) {
          setBase(path, draft.baseModifiedMs);
        } else {
          dropDraft(path);
          setBase(path, file.modifiedMs);
        }
        const text = draft?.text ?? file.text;
        setSeed((prev) => ({
          text,
          crlf: text.includes("\r\n"),
          version: (prev?.version ?? 0) + 1,
        }));
        setPreviewText(text);
        setProblem(null);
        setError(null);
        // A draft picked back up is unsaved work the editor itself knows
        // nothing about (it opens "clean"), so Autosave is started for it here.
        if (draft) scheduleAutosave();
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setContent(null);
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloads]);

  // An image is read as bytes rather than text, so it takes a second trip.
  useEffect(() => {
    if (!image) return;
    let cancelled = false;
    api
      .blobDataUrl(root || path, path, "workdir")
      .then((url) => {
        if (!cancelled) setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [image, path, root, reloads]);

  const save = async (force = false) => {
    window.clearTimeout(timer.current);
    const handle = editor.current;
    // ⌘S on a file that matches the disk would only touch its timestamp.
    if (!handle || (!force && !isDirtyNow(path))) return;
    const version = handle.version();
    setSaving(true);
    const result = await saveFile(path, handle.getText(), force);
    setSaving(false);
    if (result.ok) {
      setProblem(null);
      // Typing that landed while the write was in flight is not on disk yet:
      // the file stays dirty, and Autosave takes it from there.
      if (editor.current && editor.current.version() === version) {
        editor.current.markClean();
        dropDraft(path);
      } else {
        scheduleAutosave();
      }
    } else {
      setProblem({
        conflict: result.conflict,
        message: result.conflict ? "" : result.message,
      });
    }
  };

  function scheduleAutosave() {
    window.clearTimeout(timer.current);
    if (!live.current.autosave || live.current.conflict) return;
    timer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }

  // Autosave switched on with edits waiting: write them now; switched off:
  // stop the clock, they wait for ⌘S.
  useEffect(() => {
    if (!settings.autosave) {
      window.clearTimeout(timer.current);
    } else if (isDirtyNow(path) && !live.current.conflict) {
      void save();
    }
    // `save` closes over nothing that changes for a given tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.autosave]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onFlush = (text: string) => {
    // The tab is going away with edits that never reached the disk. Keep them
    // as a draft either way — it is what a reopened tab shows and what marks
    // the tab dirty — and with Autosave on, write them too.
    stashDraft(path, { text, baseModifiedMs: getBase(path) });
    if (live.current.autosave && !live.current.conflict) {
      void saveFile(path, text).then((result) => {
        if (result.ok) dropDraft(path);
      });
    }
  };

  const reload = async () => {
    if (dirty) {
      const discard = await ask(`Discard your unsaved changes to ${name} and re-read it from disk?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
    }
    discardEdits();
  };

  /** Throws the editor's edits away and reads the file again. */
  const discardEdits = () => {
    window.clearTimeout(timer.current);
    // Marked clean first, so the editor that is about to be replaced has
    // nothing to hand back as a draft on its way out.
    editor.current?.markClean();
    dropDraft(path);
    setProblem(null);
    setReloads((n) => n + 1);
  };

  const showPreview = (next: "source" | "preview") => {
    if (next === "preview") setPreviewText(editor.current?.getText() ?? seed?.text ?? "");
    setMode(next);
  };

  const editable = !!content?.editable;
  const relative =
    root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-6 py-1.5 text-[12px] text-[var(--faint)]">
        <span className="flex shrink-0 items-center">
          <FileIcon name={name} size={14} />
        </span>
        <span title={path} className="min-w-0 flex-1 truncate">
          <span className="font-medium text-[var(--ink)]">{name}</span>
          {relative !== name && <span className="ml-2">{relative}</span>}
        </span>
        {content && !content.binary && !dirty && !saving && (
          <span className="shrink-0">{sizeLabel(content.bytes)}</span>
        )}
        {content && !content.binary && !editable && !image && (
          <span
            title={readOnlyReason(content)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-[var(--card)] px-1.5 py-0.5"
          >
            <Lock size={11} strokeWidth={2} />
            Read only
          </span>
        )}
        {editable && (saving || dirty) && (
          <span className="flex shrink-0 items-center gap-1.5 text-[var(--muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--busy)]" />
            {saving ? "Saving…" : "Unsaved"}
          </span>
        )}
        {editable && dirty && !settings.autosave && (
          <button
            type="button"
            title={`Save · ${saveShortcut()}`}
            onClick={() => void save()}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[var(--card)] px-2 py-0.5 text-[var(--ink)] hover:bg-[var(--hover)]"
          >
            <Save size={11} strokeWidth={2} />
            Save
          </button>
        )}
        {preview && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--card)] p-0.5">
            {(["source", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => showPreview(option)}
                className={`cursor-pointer rounded-[5px] px-2 py-0.5 text-[12px] ${
                  mode === option
                    ? "bg-[var(--selected)] text-[var(--ink)]"
                    : "text-[var(--faint)] hover:text-[var(--ink)]"
                }`}
              >
                {option === "source" ? "Source" : "Preview"}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          title="Re-read from disk"
          onClick={() => void reload()}
          className="shrink-0 cursor-pointer rounded-md p-1 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </div>

      {content?.truncated && (
        <div className="mx-6 mb-1.5 shrink-0 rounded-md bg-[var(--card)] px-2.5 py-1 text-[11px] text-[var(--muted)]">
          Showing the first 2 MB of {sizeLabel(content.bytes)}.
        </div>
      )}

      {problem?.conflict && (
        <div className="mx-6 mb-1.5 flex shrink-0 items-center gap-2 rounded-md bg-[rgba(224,144,76,0.14)] px-2.5 py-1.5 text-[12px] text-[var(--ink)]">
          <span className="min-w-0 flex-1">
            {name} changed on disk while you were editing it. Nothing was saved.
          </span>
          <button
            type="button"
            onClick={discardEdits}
            className="shrink-0 cursor-pointer rounded-md bg-[var(--card)] px-2 py-0.5 hover:bg-[var(--hover)]"
          >
            Reload (lose my edits)
          </button>
          <button
            type="button"
            onClick={() => void save(true)}
            className="shrink-0 cursor-pointer rounded-md bg-[var(--card)] px-2 py-0.5 hover:bg-[var(--hover)]"
          >
            Overwrite
          </button>
        </div>
      )}
      {problem && !problem.conflict && (
        <div className="mx-6 mb-1.5 shrink-0 rounded-md bg-[rgba(224,112,112,0.14)] px-2.5 py-1.5 text-[12px] text-[var(--danger)]">
          Could not save {name}: {problem.message}
        </div>
      )}

      {error ? (
        <Centered text={error} danger />
      ) : loading && !content ? (
        <Centered text="Reading…" />
      ) : image ? (
        <div className="image-checker m-4 flex min-h-0 flex-1 items-center justify-center rounded-lg border border-[var(--border)] p-3">
          {imageUrl ? (
            <img src={imageUrl} alt={name} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-xs text-[var(--faint)]">Could not read this image</span>
          )}
        </div>
      ) : content?.binary ? (
        <Centered text={`Binary file · ${sizeLabel(content.bytes)}`} />
      ) : (
        seed && (
          <>
            {preview && mode === "preview" && <PreviewPane text={previewText} kind={preview} />}
            {/* Kept mounted behind the preview so flipping back to Source finds
              the cursor, the scroll position and the undo history where they
              were. */}
            <div
              className={
                preview && mode === "preview" ? "hidden" : "flex min-h-0 flex-1 flex-col pl-2"
              }
            >
              <CodeEditor
                key={seed.version}
                ref={editor}
                name={name}
                initialText={seed.text}
                crlf={seed.crlf}
                readOnly={!editable}
                fontSize={settings.fontSize}
                wordWrap={settings.wordWrap}
                onChange={() => {
                  setFileDirty(path, true);
                  scheduleAutosave();
                }}
                onSave={() => void save()}
                onBlur={() => {
                  if (live.current.autosave && !live.current.conflict && isDirtyNow(path)) {
                    void save();
                  }
                }}
                onFlush={onFlush}
              />
            </div>
          </>
        )
      )}
    </div>
  );
}

function isDirtyNow(path: string): boolean {
  return !!useDirtyFiles.getState().paths[path];
}

/** The keyboard shortcut the Save button's tooltip quotes. */
function saveShortcut(): string {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘S" : "Ctrl+S";
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
