import hljs from "highlight.js/lib/common";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../lib/api";
import type { FileContent } from "../lib/types";
import { useEgant, workspaceRoot } from "../store";
import { Markdown } from "./Markdown";
import { useEditorFontSize } from "./SettingsKit";

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

/** Past this, highlighting costs more than it gives: a file this size is
 * being scanned, not read, and the parse would block the window. */
const HIGHLIGHT_LIMIT = 400_000;

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

/** A file open as a tab on the stage: read-only, highlighted, with the line
 * numbers a conversation about code needs to refer to. It reads the file on
 * open rather than watching it — the agent edits constantly, and a viewer that
 * redrew under the user mid-read would be worse than one they refresh. */
export function FileView({ path, name }: { path: string; name: string }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloads, setReloads] = useState(0);
  const [mode, setMode] = useState<"source" | "preview">(() =>
    // A README is something to read; a config file is something to inspect.
    previewKind(name) === "markdown" ? "preview" : "source",
  );
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const root = useEgant((s) => workspaceRoot(s.snapshot));
  const preview = previewKind(name);
  const image = isImage(name);
  // Settings > Files > Editor font size, live. Painted as a CSS variable so
  // the gutter and the code stay on one grid at whatever size is picked.
  const editorFontSize = useEditorFontSize();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .readFile(path)
      .then((file) => {
        if (cancelled) return;
        setContent(file);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        setContent(null);
        setError(problem instanceof Error ? problem.message : String(problem));
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

  const text = content?.binary ? "" : (content?.text ?? "");

  const html = useMemo(() => {
    if (!text) return "";
    const language = languageFor(name);
    if (!language || text.length > HIGHLIGHT_LIMIT) return escapeHtml(text);
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      // A grammar that chokes on this file is not a reason to show nothing.
      return escapeHtml(text);
    }
  }, [text, name]);

  const lines = useMemo(() => {
    if (!text) return "";
    // A trailing newline ends the last line rather than starting a new one.
    const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join("\n");
  }, [text]);

  const relative =
    root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--editor-font-size": `${editorFontSize}px` } as CSSProperties}
    >
      <div className="flex shrink-0 items-center gap-2 px-6 py-1.5 text-[12px] text-[var(--faint)]">
        <span title={path} className="min-w-0 flex-1 truncate">
          {relative}
        </span>
        {content && !content.binary && (
          <span className="shrink-0">{sizeLabel(content.bytes)}</span>
        )}
        {preview && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--card)] p-0.5">
            {(["source", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={mode === option}
                onClick={() => setMode(option)}
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
          onClick={() => setReloads((n) => n + 1)}
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
      ) : preview && mode === "preview" ? (
        <PreviewPane text={text} kind={preview} />
      ) : content?.binary ? (
        <Centered text={`Binary file · ${sizeLabel(content.bytes)}`} />
      ) : text === "" ? (
        <Centered text="Empty file" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          <div className="flex min-w-max">
            <pre className="code-gutter" aria-hidden="true">
              {lines}
            </pre>
            <pre className="code-pane" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      )}
    </div>
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

/** Used when nothing is highlighted — the text still goes through
 * `innerHTML`, so it still has to be safe. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
