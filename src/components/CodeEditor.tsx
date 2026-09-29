import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace';

/** The same palette the read-only highlighter paints with (`--code-*`), so a
 * file reads the same in the editor, the diff tab and a tool card. */
const highlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--code-comment)", fontStyle: "italic" },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.modifier,
      t.self,
      t.null,
      t.bool,
      t.atom,
    ],
    color: "var(--code-keyword)",
  },
  { tag: [t.string, t.regexp, t.special(t.string), t.inserted], color: "var(--code-string)" },
  { tag: [t.number, t.integer, t.float, t.escape, t.character], color: "var(--code-number)" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.function(t.variableName)),
      t.tagName,
    ],
    color: "var(--code-function)",
  },
  { tag: t.heading, color: "var(--code-function)", fontWeight: "600" },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)],
    color: "var(--code-type)",
  },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-attr)" },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: "var(--code-meta)" },
  { tag: t.deleted, color: "var(--diff-del-fg)" },
  { tag: [t.link, t.url], color: "var(--code-function)", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
]);

const baseTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: MONO, lineHeight: "1.55", overflow: "auto" },
  ".cm-content": { caretColor: "var(--cursor)", padding: "0 0 12px" },
  ".cm-line": { padding: "0 24px 0 4px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--cursor)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--faint)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent) !important",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 34%, transparent) !important",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
    outline: "none",
  },
  ".cm-specialChar": { color: "var(--faint)" },
  // The find bar (⌘F): a slim strip over the top of the text, in the app's
  // own surface colors rather than CodeMirror's stock light panel.
  ".cm-panels": {
    backgroundColor: "var(--stage)",
    color: "var(--ink)",
    borderBottom: "1px solid var(--border)",
  },
  ".cm-panel.cm-search": { padding: "6px 10px", fontFamily: "inherit", fontSize: "12px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": {
    fontFamily: "inherit",
    fontSize: "12px",
    color: "var(--ink)",
    backgroundColor: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    padding: "2px 8px",
  },
  ".cm-panel.cm-search button": { cursor: "pointer", backgroundImage: "none" },
  ".cm-panel.cm-search label": { color: "var(--muted)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--busy) 28%, transparent)" },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--busy) 50%, transparent)",
  },
});

const sizeTheme = (px: number) =>
  EditorView.theme({ "&": { fontSize: `${px}px` } });

/** What the parent can ask of a mounted editor. */
export interface CodeEditorHandle {
  /** The whole document, with the file's own line endings. */
  getText: () => string;
  /** How many edits the document has taken. A save records it before writing
   * and only calls the file clean if it has not moved by the time the write
   * lands. */
  version: () => number;
  /** Marks the document as matching the disk. */
  markClean: () => void;
  focus: () => void;
}

interface Props {
  /** Filename, for picking a grammar. */
  name: string;
  /** The text to open with. Changing it does nothing — remount (`key`) to open
   * different text. */
  initialText: string;
  /** The file uses `\r\n`. Kept on save rather than quietly rewritten to `\n`. */
  crlf: boolean;
  readOnly: boolean;
  fontSize: number;
  wordWrap: boolean;
  /** The document changed. */
  onChange: () => void;
  /** ⌘S / Ctrl+S. */
  onSave: () => void;
  onBlur: () => void;
  /** The editor is going away with edits that were never marked clean. */
  onFlush: (text: string) => void;
}

/** A CodeMirror editor dressed in the app's own colors. It knows nothing about
 * files or saving: it holds text, reports that it changed, and hands the text
 * back when asked. */
export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(props, ref) {
  const { name, initialText, crlf, readOnly, fontSize, wordWrap } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The latest callbacks, read at event time: the editor is built once, and
  // must not capture the first render's closures.
  const callbacks = useRef(props);
  callbacks.current = props;
  const edits = useRef(0);
  const cleanAt = useRef(0);

  const languageConf = useRef(new Compartment()).current;
  const sizeConf = useRef(new Compartment()).current;
  const wrapConf = useRef(new Compartment()).current;
  const readConf = useRef(new Compartment()).current;

  const textOf = (view: EditorView) =>
    view.state.doc.sliceString(0, view.state.doc.length, view.state.lineBreak);

  useImperativeHandle(
    ref,
    () => ({
      getText: () => (viewRef.current ? textOf(viewRef.current) : ""),
      version: () => edits.current,
      markClean: () => {
        cleanAt.current = edits.current;
      },
      focus: () => viewRef.current?.focus(),
    }),
    [],
  );

  // Built once per mount. The parent remounts (by `key`) to open other text,
  // so the options read here are the ones this editor starts with; everything
  // that can change while it is open has its own effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          lineNumbers(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          highlightSelectionMatches(),
          search({ top: true }),
          EditorState.tabSize.of(2),
          crlf ? EditorState.lineSeparator.of("\r\n") : [],
          syntaxHighlighting(highlight),
          baseTheme,
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          languageConf.of([]),
          sizeConf.of(sizeTheme(fontSize)),
          wrapConf.of(wordWrap ? EditorView.lineWrapping : []),
          readConf.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            edits.current += 1;
            callbacks.current.onChange();
          }),
          EditorView.domEventHandlers({
            blur: () => {
              callbacks.current.onBlur();
            },
          }),
        ],
      }),
    });
    viewRef.current = view;

    // Grammars load on demand — a file in a language nobody opened costs
    // nothing — and the text is already readable while it arrives.
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, name);
    description
      ?.load()
      .then((support) => {
        if (!cancelled) view.dispatch({ effects: languageConf.reconfigure(support) });
      })
      .catch(() => {
        // No grammar is not an error: the file stays plain text.
      });

    return () => {
      cancelled = true;
      if (edits.current !== cleanAt.current) callbacks.current.onFlush(textOf(view));
      view.destroy();
      viewRef.current = null;
    };
    // Deliberately once: see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: sizeConf.reconfigure(sizeTheme(fontSize)) });
  }, [fontSize, sizeConf]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapConf.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap, wrapConf]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readConf.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly, readConf]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={hostRef} className="absolute inset-0" />
    </div>
  );
});
