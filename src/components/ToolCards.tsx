import {
  AlignJustify,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  Search,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import hljs from "highlight.js/lib/common";
import {
  basename,
  normalizeEdit,
  stripLineNumbers,
  toolCategory,
  toolCommand,
  toolFilePath,
  toolSummary,
  toolWriteContent,
  truncate,
} from "../lib/transcript";
import type { Entry } from "../lib/types";
import { AddedLinesView, DiffView } from "./DiffView";
import { FileIcon } from "./FileIcon";
import { languageFor } from "./FileView";
import { FileIcon } from "./FileIcon";

export type ToolEntry = Extract<Entry, { kind: "tool" }>;

// ---------------------------------------------------------------------------
// Diff counts — client-side, from the tool input snippets (no backend change).
// An Edit diffs old_string → new_string per op; a Write is a pure addition.
// ---------------------------------------------------------------------------

function chunkCount(value: string): number {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function editOpStat(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText ?? "", newText ?? "")) {
    const n = chunkCount(part.value);
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

function entryStat(entry: ToolEntry): { added: number; removed: number } {
  const cat = toolCategory(entry.name);
  if (cat === "edit") {
    const { edits } = normalizeEdit(entry.name, entry.input);
    let added = 0;
    let removed = 0;
    for (const op of edits) {
      const s = editOpStat(op.old_string, op.new_string);
      added += s.added;
      removed += s.removed;
    }
    return { added, removed };
  }
  if (cat === "write") {
    return { added: chunkCount(toolWriteContent(entry.input)), removed: 0 };
  }
  return { added: 0, removed: 0 };
}

// ---------------------------------------------------------------------------
// Summary sentence — the collapsed row's words ("Edited commands.rs",
// "Ran 2 commands, edited conflict.rs", "Created a file, edited a file").
// Totals ride alongside as green +N / red -M whenever edits are present.
// ---------------------------------------------------------------------------

function capitalize(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function decapitalize(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function truncateCommand(command: string, limit = 32): string {
  const single = command.replace(/\s+/g, " ").trim();
  if (single.length <= limit) return single;
  return `${single.slice(0, limit).trimEnd()}...`;
}

function distinctPaths(entries: ToolEntry[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    const p = toolFilePath(entry.input);
    if (p) out.add(p);
  }
  return out;
}

export interface ActivitySummary {
  text: string;
  added: number;
  removed: number;
  hasDiff: boolean;
}

export function activitySummary(entries: ToolEntry[]): ActivitySummary {
  let added = 0;
  let removed = 0;
  for (const entry of entries) {
    const s = entryStat(entry);
    added += s.added;
    removed += s.removed;
  }
  const writes = entries.filter((e) => toolCategory(e.name) === "write");
  const edits = entries.filter((e) => toolCategory(e.name) === "edit");
  const reads = entries.filter((e) => toolCategory(e.name) === "read");
  const commands = entries.filter((e) => toolCategory(e.name) === "command");
  const others = entries.filter((e) => toolCategory(e.name) === "other");
  const hasDiff = writes.length + edits.length > 0;

  let text: string;
  if (entries.length === 1) {
    const entry = entries[0]!;
    const cat = toolCategory(entry.name);
    const base = basename(toolFilePath(entry.input)) || "file";
    if (cat === "edit") text = `Edited ${base}`;
    else if (cat === "write") text = `Created ${base}`;
    else if (cat === "read") text = `Read ${base}`;
    else if (cat === "command") {
      const cmd = truncateCommand(toolCommand(entry.input));
      text = cmd ? `Ran ${cmd}` : "Ran command";
    } else {
      const summary = toolSummary(entry.input, entry.name);
      text =
        summary && summary !== entry.name
          ? `${entry.name} ${truncate(summary.split("\n")[0] ?? summary, 60)}`
          : entry.name;
    }
  } else {
    // One file touched by edits and reads reads as a single phrase.
    const fileEntries = [...edits, ...reads, ...writes];
    const uniqueFiles = new Set(
      fileEntries.map((e) => basename(toolFilePath(e.input))).filter(Boolean),
    );
    if (
      writes.length === 0 &&
      commands.length === 0 &&
      others.length === 0 &&
      uniqueFiles.size === 1 &&
      edits.length > 0 &&
      reads.length > 0
    ) {
      text = `Edited and read ${[...uniqueFiles][0]!}`;
    } else {
      const parts: string[] = [];
      if (writes.length > 0) {
        if (writes.length === 1) {
          parts.push(`Created ${basename(toolFilePath(writes[0]!.input)) || "a file"}`);
        } else {
          parts.push(`Created ${writes.length} files`);
        }
      }
      if (edits.length > 0) {
        if (edits.length === 1) {
          parts.push(`Edited ${basename(toolFilePath(edits[0]!.input)) || "a file"}`);
        } else {
          const files = distinctPaths(edits);
          if (files.size === 1) {
            const only = [...files][0]!;
            parts.push(`Edited ${basename(only) || "a file"}`);
          } else {
            parts.push(`Edited ${files.size > 0 ? files.size : edits.length} files`);
          }
        }
      }
      if (reads.length > 0) {
        if (reads.length === 1 && edits.length === 0 && writes.length === 0) {
          parts.push(`Read ${basename(toolFilePath(reads[0]!.input)) || "a file"}`);
        } else if (reads.length === 1) {
          parts.push(`read ${basename(toolFilePath(reads[0]!.input)) || "a file"}`);
        } else {
          parts.push(`read ${reads.length} files`);
        }
      }
      if (commands.length === 1) {
        const cmd = truncateCommand(toolCommand(commands[0]!.input));
        parts.push(cmd ? `ran ${cmd}` : "ran a command");
      } else if (commands.length > 1) {
        parts.push(`ran ${commands.length} commands`);
      }
      for (const entry of others) {
        parts.push(decapitalize(entry.name));
      }
      if (parts.length === 0) parts.push(`${entries.length} tool calls`);
      text = parts
        .map((part, i) => (i === 0 ? capitalize(part) : part))
        .join(", ");
    }
  }

  return { text, added, removed, hasDiff };
}

function DiffCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono">
      <span className="text-[var(--diff-add-fg)]">+{added}</span>{" "}
      <span className="text-[var(--diff-del-fg)]">-{removed}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Themed code — the same treatment as the stage file viewer (FileView): a
// gutter of line numbers beside highlight.js-colored code, plus a copy
// button, so a dropdown reads like the file it came from instead of plain
// faint text. The language resolves from the filename, exactly like FileView.
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function CopyButton({ text, title }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title={copied ? "Copied" : (title ?? "Copy")}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={2} />}
    </button>
  );
}

/** Path header above a dropdown's code, like the screenshot: the file's type
 * icon plus the full path on the left, a copy button on the right. */
function BodyHeader({ path, copyText }: { path?: string; copyText?: string }) {
  if (!path && !copyText) return null;
  const name = path ? (basename(path) || "file") : "";
  const isDir = !!path && path.endsWith("/");
  return (
    <div className="flex items-center gap-2">
      {path ? (
        <>
          <FileIcon name={name} isDir={isDir} size={12} />
          <div title={path} className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--faint)]">
            {path}
          </div>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {copyText ? <CopyButton text={copyText} title="Copy code" /> : null}
    </div>
  );
}

/** Numbered, syntax-colored code in the file viewer's own grid
 * (`.code-gutter` + `.code-pane`), inside a scrollable rounded block. */
function HighlightedBlock({
  fileName,
  text,
  numbers,
}: {
  fileName: string;
  text: string;
  numbers?: string;
}) {
  const language = languageFor(fileName);
  const html = useMemo(() => {
    if (text.length > 400_000) return escapeHtml(text);
    if (!language) return escapeHtml(text);
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return escapeHtml(text);
    }
  }, [text, language]);
  const gutter = useMemo(() => {
    if (numbers !== undefined) return numbers;
    const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    return Array.from({ length: Math.max(count, 1) }, (_, i) => String(i + 1)).join("\n");
  }, [text, numbers]);
  return (
    <div className="max-h-[320px] overflow-auto rounded-lg bg-[rgba(0,0,0,0.15)] py-2">
      <div className="flex min-w-max">
        <pre className="code-gutter" aria-hidden="true">
          {gutter}
        </pre>
        <pre className="code-pane" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

/** Split a `Read` tool's output into gutter numbers plus code. The harness
 * hands back `cat -n`-style numbered lines (`"    12\t…"` or `"12: …"`),
 * so the gutter shows the file's real line numbers — the `1..20` on the left
 * of the screenshot — rather than renumbering from 1. Falls back to 1-based
 * numbering when the output carries no numbers. */
function splitReadLines(output: string): { numbers: string; text: string } {
  const raw = output.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  let hits = 0;
  let blanks = 0;
  const rows = raw.map((line) => {
    const m = line.match(/^\s*(\d+)(?:\t|: )/);
    if (m) {
      hits++;
      return { no: m[1]!, text: line.slice(m[0].length) };
    }
    if (line.trim() === "") blanks++;
    return { no: "", text: line };
  });
  if (hits >= Math.max(2, Math.ceil((rows.length - blanks) * 0.8))) {
    return {
      numbers: rows.map((row) => row.no).join("\n"),
      text: rows.map((row) => row.text).join("\n"),
    };
  }
  const stripped = stripLineNumbers(output);
  const count = stripped.split("\n").length;
  return {
    numbers: Array.from({ length: count }, (_, i) => String(i + 1)).join("\n"),
    text: stripped,
  };
}

// ---------------------------------------------------------------------------
// Grouping — retired. Every tool call renders as its own dropdown row so the
// model's own words stay interleaved between them ("Now let's guard…",
// "Edited commands.rs +7 -0 ›", "Now register…"), instead of every call in a
// turn collapsing into one giant dropdown. `groupEntries`/`RenderItem` are
// kept as thin shims so older callers keep compiling.
// ---------------------------------------------------------------------------

export type RenderItem =
  | { kind: "single"; index: number; entry: Entry }
  | { kind: "activity"; index: number; entries: ToolEntry[] };

export function groupEntries(entries: Entry[]): RenderItem[] {
  return entries.map((entry, index) =>
    entry.kind === "tool"
      ? { kind: "activity", index, entries: [entry] }
      : { kind: "single", index, entry },
  );
}

// ---------------------------------------------------------------------------
// Bodies — what each dropdown reveals. Reads render numbered highlighted
// code with the file's real line numbers; edits keep the green/red diff but
// with per-line highlighting in the file's language; writes render additions
// the same way; commands and every other tool get the same rounded frame,
// path/command header and copy button.
// ---------------------------------------------------------------------------

function ReadBody({ entry }: { entry: ToolEntry }) {
  const filePath = toolFilePath(entry.input);
  const base = basename(filePath) || "file";
  const raw = entry.output ?? "";
  const { numbers, text } = useMemo(
    () => splitReadLines(truncate(raw, 4000)),
    [raw],
  );
  if (entry.isError) {
    return (
      <div className="flex flex-col gap-1.5">
        <BodyHeader path={filePath} />
        <div className="max-h-[320px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-[var(--danger)]">
          {truncate(raw, 4000)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <BodyHeader path={filePath} copyText={text} />
      <HighlightedBlock fileName={base} text={text} numbers={numbers} />
    </div>
  );
}

const MAX_RENDERED_EDITS = 20;

function EditBody({ entry }: { entry: ToolEntry }) {
  const { filePath, edits } = normalizeEdit(entry.name, entry.input);
  const base = basename(filePath);
  const language = languageFor(base);
  const shown = edits.slice(0, MAX_RENDERED_EDITS);
  const hidden = edits.length - shown.length;
  const copyText = useMemo(
    () => truncate(shown.map((edit) => edit.new_string).join("\n"), 4000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entry],
  );
  return (
    <div className="flex flex-col gap-1.5">
      <BodyHeader path={filePath} copyText={copyText || undefined} />
      {shown.map((edit, index) => (
        <DiffView
          key={index}
          oldText={edit.old_string}
          newText={edit.new_string}
          language={language}
        />
      ))}
      {hidden > 0 && (
        <div className="text-xs text-[var(--faint)]">
          + {hidden} more edit{hidden === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}

function WriteBody({ entry }: { entry: ToolEntry }) {
  const filePath = toolFilePath(entry.input);
  const base = basename(filePath);
  const language = languageFor(base);
  const content = truncate(toolWriteContent(entry.input), 4000);
  return (
    <div className="flex flex-col gap-1.5">
      <BodyHeader path={filePath} copyText={content || undefined} />
      <AddedLinesView text={content} language={language} />
    </div>
  );
}

/** One shell token with its color: the command itself blue, flags orange,
 * quoted strings green, shell operators faint, arguments plain — the `$ npx
 * tsc --noEmit …` pill in the reference. */
type BashTone = "cmd" | "flag" | "string" | "op" | "arg";

function tokenizeBash(command: string): { text: string; tone: BashTone }[] {
  const raw = command.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  let expectCmd = true;
  return raw.map((token) => {
    if (/^["']/.test(token)) return { text: token, tone: "string" as BashTone };
    if (/^([|&;]+|\d*[<>][&\d>]*)$/.test(token)) {
      if (/[|&;]/.test(token)) expectCmd = true;
      return { text: token, tone: "op" as BashTone };
    }
    if (expectCmd) {
      expectCmd = false;
      return { text: token, tone: "cmd" as BashTone };
    }
    if (token.length > 1 && token.startsWith("-")) {
      return { text: token, tone: "flag" as BashTone };
    }
    return { text: token, tone: "arg" as BashTone };
  });
}

function bashToneClass(tone: BashTone): string {
  switch (tone) {
    case "cmd":
      return "text-[var(--code-function)]";
    case "flag":
      return "text-[var(--code-number)]";
    case "string":
      return "text-[var(--code-string)]";
    case "op":
      return "text-[var(--faint)]";
    default:
      return "text-[var(--ink)]";
  }
}

/** The `$ command` pill: prompt marker plus bash-colored tokens in a filled
 * rounded bar. */
function BashPill({ command }: { command: string }) {
  const tokens = useMemo(() => tokenizeBash(command), [command]);
  return (
    <div
      title={command}
      className="overflow-x-auto rounded-lg bg-[rgba(255,255,255,0.045)] px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre"
    >
      <span className="text-[var(--faint)] select-none">$ </span>
      {tokens.map((token, index) => (
        <span key={index}>
          {index > 0 && " "}
          <span className={bashToneClass(token.tone)}>{token.text}</span>
        </span>
      ))}
    </div>
  );
}

/** The tool's own description when the agent gave one (`Ran npx tsc…`), else
 * empty — the row then reads the generic `Ran a command`. */
function commandSnippet(entry: ToolEntry): string {
  const record = (entry.input ?? {}) as Record<string, unknown>;
  const raw = record.description;
  if (typeof raw !== "string" || raw.trim() === "") return "";
  return truncate(raw.trim().split("\n")[0] ?? "", 40);
}

/** One run's expandable content: the `$` pill plus its output — shared by the
 * legacy `CommandRow` header and the grouped activity rows, so a Run row
 * drops down exactly the way a command card always has. */
function CommandBody({ entry }: { entry: ToolEntry }) {
  const command = toolCommand(entry.input);
  const output = entry.output == null ? null : truncate(entry.output, 4000);
  const empty = output != null && output.trim() === "";
  return (
    <>
      {command ? <BashPill command={truncate(command, 2000)} /> : null}
      {output == null ? null : empty && !entry.isError ? (
        <div className="font-mono text-[12px] leading-6 text-[var(--faint)]">
          ({capitalize(entry.name)} completed with no output)
        </div>
      ) : (
        <div
          className={`font-mono text-[12px] leading-6 whitespace-pre-wrap ${
            entry.isError ? "text-[var(--danger)]" : "text-[var(--muted)]"
          }`}
        >
          {output}
        </div>
      )}
    </>
  );
}

/** One run inside a command group: `Ran npx tsc… ∨`, the `$` pill, then the
 * output as plain text — or `(Bash completed with no output)` when it ran
 * silent. */
function CommandRow({ entry }: { entry: ToolEntry }) {
  const [expanded, setExpanded] = useState(true);
  const snippet = commandSnippet(entry);
  const busy = entry.output == null && !entry.isError;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 text-left text-[13px]"
      >
        {snippet ? (
          <>
            <span className="shrink-0 text-[var(--faint)]">Ran</span>
            <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{snippet}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[var(--muted)]">Ran a command</span>
        )}
        <span className="shrink-0 text-[var(--faint)]">
          {expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        {busy && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />
        )}
        {entry.isError && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
        )}
      </button>
      {expanded && <CommandBody entry={entry} />}
    </div>
  );
}

/** Consecutive shell runs as one `Ran N commands` dropdown that opens onto a
 * card per run — the reference layout. A lone run renders as its own card
 * with no outer wrapper. */
export function CommandGroup({ entries }: { entries: ToolEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const busy = entries.some((entry) => entry.output == null);
  const failed = entries.some((entry) => entry.isError);

  if (entries.length === 1) {
    return (
      <div className="flex w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <CommandRow entry={entries[0]!} />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 py-0.5 text-left text-[13px]"
      >
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
          Ran {entries.length} commands
        </span>
        <span className="shrink-0 text-[var(--faint)]">
          {expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        {busy && !failed && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />
        )}
        {failed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />}
      </button>
      {expanded && (
        <div className="mt-1 flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
          {entries.map((entry, index) => (
            <div
              key={entry.id || `${entry.name}-${index}`}
              className={index > 0 ? "border-t border-[var(--border)]" : undefined}
            >
              <CommandRow entry={entry} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TodoItem {
  content: string;
  status: string;
}

function parseTodos(input: unknown): TodoItem[] | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const list = record.todos ?? record.todo ?? record.tasks;
  if (!Array.isArray(list)) return null;
  const out: TodoItem[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const content =
      (typeof row.content === "string" && row.content) ||
      (typeof row.title === "string" && row.title) ||
      (typeof row.text === "string" && row.text) ||
      (typeof row.task === "string" && row.task) ||
      "";
    if (!content) continue;
    const status =
      (typeof row.status === "string" && row.status) ||
      (typeof row.state === "string" && row.state) ||
      "pending";
    out.push({ content, status });
  }
  return out;
}

function todoTone(status: string): string {
  const lower = status.toLowerCase().replace(/[_\s-]+/g, "");
  if (lower.includes("complete") || lower === "done") return "bg-[var(--diff-add-fg)]";
  if (lower.includes("progress") || lower === "active" || lower === "running")
    return "bg-[var(--busy)]";
  return "bg-[var(--faint)]";
}

/** TodoWrite/TodoRead and friends: just the todo list itself — one row per
 * item with a status dot. The tool's output is only ever an echo of the same
 * list as raw JSON, so it stays hidden. */
function TodoBody({ entry }: { entry: ToolEntry }) {
  const todos = parseTodos(entry.input);
  if (!todos) return <GenericBody entry={entry} />;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col overflow-hidden rounded-lg bg-[rgba(0,0,0,0.15)]">
        {todos.map((todo, index) => (
          <div
            key={index}
            className="flex items-center gap-2 px-2.5 py-1.5 text-[12px] leading-5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-[var(--border)]"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${todoTone(todo.status)}`} />
            <span className="min-w-0 flex-1 truncate text-[var(--ink)]" title={todo.content}>
              {todo.content}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-[var(--faint)]">
              {todo.status.replace(/_/g, " ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function isTodoTool(name: string): boolean {
  return ["todowrite", "todoread", "todo"].includes(name.toLowerCase());
}

/** Any other tool (Grep, Glob, WebFetch, …): the identifying input as
 * highlighted search text plus the output in the same rounded frame with a
 * copy button — no more unthemed raw dumps. */
function GenericBody({ entry }: { entry: ToolEntry }) {
  const summary = toolSummary(entry.input, entry.name);
  const showSummary = summary && summary !== entry.name;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {showSummary ? (
          <div
            className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--faint)]"
            title={summary}
          >
            {truncate(summary, 500)}
          </div>
        ) : (
          <span className="flex-1" />
        )}
        {entry.output != null && (
          <CopyButton text={truncate(entry.output, 4000)} title="Copy output" />
        )}
      </div>
      {entry.output != null && (
        <div
          className={`max-h-[320px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap ${
            entry.isError ? "text-[var(--danger)]" : "text-[var(--faint)]"
          }`}
        >
          {truncate(entry.output, 4000)}
        </div>
      )}
    </div>
  );
}

function singleRowLabel(entry: ToolEntry): { text: string; added: number; removed: number; hasDiff: boolean } {
  const summary = activitySummary([entry]);
  return { text: summary.text, added: summary.added, removed: summary.removed, hasDiff: summary.hasDiff };
}

/** One tool call as its own dropdown row: the collapsed
 * "Edited commands.rs +7 -0 ›" line, and on expand the file path plus its
 * green/red diff directly underneath — no nested dropdown-in-dropdown. Every
 * tool family (edits, creates, reads, commands) renders through here, so a
 * turn with five calls shows five rows with the model's own words still
 * interleaved between them. */
export function ToolActivityRow({ entry }: { entry: ToolEntry }) {
  const [expanded, setExpanded] = useState(() => isTodoTool(entry.name));
  const label = useMemo(() => singleRowLabel(entry), [entry]);
  const busy = entry.output == null;
  const cat = toolCategory(entry.name);
  // Shell runs render through the command group, even solo — one card, no
  // outer activity chrome.
  if (cat === "command") {
    return <CommandGroup entries={[entry]} />;
  }
  const filePath = toolFilePath(entry.input);
  const hasBody =
    entry.output != null || cat === "edit" || cat === "write" || isTodoTool(entry.name);
  const fileName = filePath ? basename(filePath) || "file" : "";
  const fileIsDir = filePath.endsWith("/");
  const showFileIcon = filePath !== "" && cat !== "other";

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        title={filePath || toolSummary(entry.input, entry.name) || undefined}
        className={`flex items-center gap-1.5 py-0.5 text-left text-[13px] ${
          hasBody ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="shrink-0 text-[var(--faint)]">
          {hasBody ? (
            expanded ? (
              <ChevronDown size={12} strokeWidth={2} />
            ) : (
              <ChevronRight size={12} strokeWidth={2} />
            )
          ) : (
            <ChevronRight size={12} strokeWidth={2} className="opacity-40" />
          )}
        </span>
        {showFileIcon && <FileIcon name={fileName} isDir={fileIsDir} size={13} />}
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{label.text}</span>
        {label.hasDiff && <DiffCounts added={label.added} removed={label.removed} />}
        {busy && !entry.isError && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />
        )}
        {entry.isError && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
        )}
      </button>
      {expanded && hasBody && (
        <div className="mt-1 ml-[7px] flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--card)] px-2.5 py-2">
          {cat === "edit" && !entry.isError ? (
            <EditBody entry={entry} />
          ) : cat === "write" && !entry.isError ? (
            <WriteBody entry={entry} />
          ) : cat === "read" ? (
            entry.output != null ? (
              <ReadBody entry={entry} />
            ) : null
          ) : isTodoTool(entry.name) ? (
            <TodoBody entry={entry} />
          ) : (
            <GenericBody entry={entry} />
          )}
        </div>
      )}
    </div>
  );
}

/** Grouped activity rows — retired along with the grouping. Kept so existing
 * callers keep compiling; renders each entry as its own row. */
export function ActivityCard({ entries }: { entries: ToolEntry[] }) {
  return (
    <div className="flex w-full flex-col gap-0.5">
      {entries.map((entry, i) => (
        <ToolActivityRow key={entry.id || `${entry.name}-${i}`} entry={entry} />
      ))}
    </div>
  );
}

/** Backwards-compatible single-tool render — an activity group of one. Kept
 * so existing callers rendering one tool entry keep working. */
export function ToolCard({ entry }: { entry: ToolEntry }) {
  return <ActivityCard entries={[entry]} />;
}

// ---------------------------------------------------------------------------
// Grouped streaming activity — the screenshot layout: one collapsible
// `Ran 1 command · read 5 files · searched 1 time` header, then one row per
// tool call joined by a vertical guide. Reads render as `Read [file-pill]`
// where the pill is the file-type icon plus basename on a fill; Search rows
// render `Search <pattern> in <path>`; Run rows render `Run <command>`.
// Clicking a row drops down just that row (accordion — opening one closes
// the others) onto the same body the single rows have always shown, and a
// Run row drops onto the normal `$` pill plus output.
// ---------------------------------------------------------------------------

/** Search-family tools read as "searched N times" in the group header and as
 * `Search` rows — matched case-insensitively so Claude (`Grep`), opencode
 * (`grep`) and future `*_search` tools all land here. */
function isSearchTool(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("search")) return true;
  return ["grep", "glob", "rg", "find", "grep_search", "textsearch"].includes(lower);
}

/** `pattern in path` for a search call, or whichever half it gave — the
 * `TextDelta|ToolCall|ToolResult in /home/.../crates` line in the reference. */
function searchDetail(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const pick = (keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim().split("\n")[0]!;
    }
    return "";
  };
  const pattern = pick(["pattern", "query", "text", "term", "keyword"]);
  const where = pick(["path", "file_path", "filePath", "directory", "dir", "folder"]);
  if (pattern && where) return `${truncate(pattern, 120)} in ${truncate(where, 160)}`;
  return truncate(pattern || where, 200);
}

/** `Ran 1 command · read 5 files · searched 1 time` — fixed verb order, not
 * list order, so a group that opens with five reads still leads with its one
 * run, exactly like the reference. Edits/writes/others join the same way
 * when a turn carries them. */
function groupHeaderText(entries: ToolEntry[]): string {
  const count = (fn: (e: ToolEntry) => boolean) => entries.filter(fn).length;
  const commands = count((e) => toolCategory(e.name) === "command");
  const reads = count((e) => toolCategory(e.name) === "read");
  const searches = count((e) => isSearchTool(e.name));
  const edits = count((e) => toolCategory(e.name) === "edit");
  const writes = count((e) => toolCategory(e.name) === "write");
  const others = entries.length - commands - reads - searches - edits - writes;
  const parts: string[] = [];
  if (commands > 0) parts.push(`Ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (reads > 0) parts.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
  if (searches > 0) parts.push(`searched ${searches} time${searches === 1 ? "" : "s"}`);
  if (edits > 0) parts.push(`edited ${edits} file${edits === 1 ? "" : "s"}`);
  if (writes > 0) parts.push(`created ${writes} file${writes === 1 ? "" : "s"}`);
  if (others > 0) parts.push(`ran ${others} other tool${others === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push(`${entries.length} tool calls`);
  return parts.join(" · ");
}

type GroupRowKind = "read" | "command" | "search" | "edit" | "write" | "other";

function groupRowKind(entry: ToolEntry): GroupRowKind {
  if (isSearchTool(entry.name)) return "search";
  const cat = toolCategory(entry.name);
  if (cat === "read" || cat === "command" || cat === "edit" || cat === "write") return cat;
  return "other";
}

function GroupRowIcon({ kind }: { kind: GroupRowKind }) {
  const cls = "shrink-0 text-[var(--faint)]";
  switch (kind) {
    case "read":
      // The reference's boxed list mark: three lines in a rounded square.
      return (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-[var(--border)] text-[var(--faint)]">
          <AlignJustify size={10} strokeWidth={2} />
        </span>
      );
    case "command":
      return (
        <span className={cls}>
          <TerminalSquare size={14} strokeWidth={2} />
        </span>
      );
    case "search":
      return (
        <span className={cls}>
          <Search size={14} strokeWidth={2} />
        </span>
      );
    case "edit":
      return (
        <span className={cls}>
          <Pencil size={14} strokeWidth={2} />
        </span>
      );
    case "write":
      return (
        <span className={cls}>
          <Plus size={14} strokeWidth={2} />
        </span>
      );
    default:
      return (
        <span className={cls}>
          <Wrench size={14} strokeWidth={2} />
        </span>
      );
  }
}

function GroupRowVerb({ kind, entry }: { kind: GroupRowKind; entry: ToolEntry }) {
  switch (kind) {
    case "read":
      return <span className="shrink-0 text-[13px] text-[var(--muted)]">Read</span>;
    case "command":
      return <span className="shrink-0 text-[13px] text-[var(--muted)]">Run</span>;
    case "search":
      return <span className="shrink-0 text-[13px] text-[var(--muted)]">Search</span>;
    case "edit":
      return <span className="shrink-0 text-[13px] text-[var(--muted)]">Edit</span>;
    case "write":
      return <span className="shrink-0 text-[13px] text-[var(--muted)]">Write</span>;
    default:
      return (
        <span className="shrink-0 text-[13px] text-[var(--muted)]">{capitalize(entry.name)}</span>
      );
  }
}

/** The file pill: file-type icon plus basename on a fill, full path on hover
 * — the `[🦀 composer.rs]` chip in the reference. */
function FilePill({ path }: { path: string }) {
  const base = basename(path) || "file";
  return (
    <span
      title={path}
      className="flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--bubble)] px-2 py-0.5"
    >
      <FileIcon name={base} size={13} />
      <span className="truncate text-[12px] text-[var(--ink)]">{base}</span>
    </span>
  );
}

/** One row inside the group: icon + verb + pill/detail, expanding onto the
 * same body the ungrouped rows show. No row-level chevron — like the
 * reference, the row itself is the affordance (hover tint + pointer). */
function GroupToolRow({
  entry,
  open,
  onToggle,
}: {
  entry: ToolEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = groupRowKind(entry);
  const cat = toolCategory(entry.name);
  const filePath = toolFilePath(entry.input);
  const hasBody =
    entry.output != null || cat === "edit" || cat === "write" || isTodoTool(entry.name);
  const busy = entry.output == null && !entry.isError;
  const detail = (() => {
    switch (kind) {
      case "read":
      case "edit":
      case "write":
        if (filePath) return <FilePill path={filePath} />;
        return (
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]">
            {truncate(toolSummary(entry.input, entry.name), 120)}
          </span>
        );
      case "command": {
        const command = toolCommand(entry.input);
        return (
          <span
            title={command || undefined}
            className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]"
          >
            {command ? truncate(command, 160) : "a command"}
          </span>
        );
      }
      case "search": {
        const text = searchDetail(entry.input) || toolSummary(entry.input, entry.name);
        return (
          <span
            title={text || undefined}
            className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]"
          >
            {text}
          </span>
        );
      }
      default: {
        const text = toolSummary(entry.input, entry.name);
        return (
          <span
            title={text || undefined}
            className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]"
          >
            {text}
          </span>
        );
      }
    }
  })();

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => hasBody && onToggle()}
        title={
          filePath || searchDetail(entry.input) || toolSummary(entry.input, entry.name) || undefined
        }
        className={`flex w-full items-center gap-2 rounded-md px-1 py-[3px] text-left ${
          hasBody ? "cursor-pointer hover:bg-[var(--hover)]" : "cursor-default"
        }`}
      >
        <GroupRowIcon kind={kind} />
        <GroupRowVerb kind={kind} entry={entry} />
        {detail}
        {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
        {entry.isError && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
        )}
      </button>
      {open && hasBody && (
        <div className="row-in mt-1 mb-1 ml-[22px] flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--card)] px-2.5 py-2">
          {cat === "edit" && !entry.isError ? (
            <EditBody entry={entry} />
          ) : cat === "write" && !entry.isError ? (
            <WriteBody entry={entry} />
          ) : cat === "read" ? (
            entry.output != null ? (
              <ReadBody entry={entry} />
            ) : null
          ) : cat === "command" ? (
            <CommandBody entry={entry} />
          ) : isTodoTool(entry.name) ? (
            <TodoBody entry={entry} />
          ) : (
            <GenericBody entry={entry} />
          )}
        </div>
      )}
    </div>
  );
}

/** Consecutive same-kind calls inside a group — `read`, `command`, `search`,
 * `edit`, `write`, `todo`, `other`. Todo tools get their own bucket so a run
 * of Todowrites never merges with surrounding Greps. */
type SubGroupKey = GroupRowKind | "todo";

function subGroupKey(entry: ToolEntry): SubGroupKey {
  if (isTodoTool(entry.name)) return "todo";
  return groupRowKind(entry);
}

/** Split a group's entries into runs of the same sub-group key, preserving
 * order — `[read, read, edit, read]` becomes `[[read, read], [edit], [read]]`
 * so only truly consecutive repeats collapse. */
function partitionRuns(entries: ToolEntry[]): ToolEntry[][] {
  const runs: ToolEntry[][] = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last.length > 0 && subGroupKey(last[last.length - 1]!) === subGroupKey(entry)) {
      last.push(entry);
    } else {
      runs.push([entry]);
    }
  }
  return runs;
}

/** `Read 5 files`, `Edited ToolCards.tsx ×4`, `Ran 3 commands` — the header
 * for one repeated run. A single-file run names the file (the "some files are
 * repeated" case) so `Edited ToolCards.tsx ×4` reads as one thing; a
 * multi-file run counts files, and counts edits too when they outnumber files. */
function subGroupLabel(subEntries: ToolEntry[]): string {
  const n = subEntries.length;
  const first = subEntries[0]!;
  const key = subGroupKey(first);
  if (key === "read" || key === "edit" || key === "write") {
    const files = distinctPaths(subEntries);
    if (files.size === 1) {
      const base = basename([...files][0]!) || "file";
      if (key === "read") return `Read ${base} ×${n}`;
      if (key === "edit") return `Edited ${base} ×${n}`;
      return `Created ${base} ×${n}`;
    }
    if (key === "read") return `Read ${n} files`;
    if (key === "edit") {
      if (files.size > 1) return `Edited ${files.size} files · ${n} times`;
      return `Edited ${n} files`;
    }
    return `Created ${n} files`;
  }
  if (key === "command") return `Ran ${n} commands`;
  if (key === "search") return `Searched ${n} times`;
  if (key === "todo") {
    const names = new Set(subEntries.map((e) => e.name.toLowerCase()));
    if (names.size === 1) {
      const raw = first.name.toLowerCase();
      return `${raw.charAt(0).toUpperCase() + raw.slice(1)} ×${n}`;
    }
    return `Todos ×${n}`;
  }
  const names = new Set(subEntries.map((e) => e.name.toLowerCase()));
  if (names.size === 1) return `${capitalize(first.name)} ×${n}`;
  return `${n} tools`;
}

/** One repeated run inside a group: its own collapsible header plus its own
 * vertical guide, so five reads read as one `Read 5 files` tree rather than
 * five loose rows. Shares the group's accordion — opening a row here closes
 * the open row elsewhere in the same group. */
function RepeatSubGroup({
  entries,
  startIndex,
  openId,
  onToggle,
}: {
  entries: ToolEntry[];
  startIndex: number;
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const label = useMemo(() => subGroupLabel(entries), [entries]);
  const key = subGroupKey(entries[0]!);
  const iconKind: GroupRowKind = key === "todo" ? "other" : key;
  const busy = entries.some((entry) => entry.output == null && !entry.isError);
  const failed = entries.some((entry) => entry.isError);

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-[3px] text-left text-[13px]"
      >
        <span className="shrink-0 text-[var(--faint)]">
          {expanded ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        <GroupRowIcon kind={iconKind} />
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{label}</span>
        {busy && !failed && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />
        )}
        {failed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />}
      </button>
      {expanded && (
        <div className="relative mt-0.5 ml-[13px] flex flex-col border-l border-[var(--border)] pl-4">
          {entries.map((entry, i) => (
            <GroupToolRow
              key={entry.id || `${entry.name}-${startIndex + i}`}
              entry={entry}
              open={openId === entry.id}
              onToggle={() => onToggle(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Consecutive tool calls as one collapsible activity block. A lone tool
 * renders as just its row (no outer header); two or more gain the summary
 * header plus the vertical guide joining the rows. Inside, consecutive
 * same-kind runs (five reads, three edits, two commands…) fold once more
 * into their own `Read 5 files` / `Edited x ×3` sub-trees, so repeats read
 * as one tree-ish branch. A group that is already a single run stays flat —
 * the outer header already says what a sub-header would. Only one row drops
 * down at a time — clicking a second row closes the first. */
export function ToolActivityGroup({ entries }: { entries: ToolEntry[] }) {
  const [groupOpen, setGroupOpen] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const header = useMemo(() => groupHeaderText(entries), [entries]);
  const runs = useMemo(() => partitionRuns(entries), [entries]);
  const busy = entries.some((entry) => entry.output == null && !entry.isError);
  const failed = entries.some((entry) => entry.isError);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));

  if (entries.length === 1) {
    const only = entries[0]!;
    return (
      <GroupToolRow
        entry={only}
        open={openId === only.id}
        onToggle={() => toggle(only.id)}
      />
    );
  }

  const flat = runs.length === 1;

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setGroupOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 py-0.5 text-left text-[13px]"
      >
        <span className="shrink-0 text-[var(--faint)]">
          {groupOpen ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{header}</span>
        {busy && !failed && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />
        )}
        {failed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />}
      </button>
      {groupOpen && (
        <div className="relative mt-0.5 ml-[7px] flex flex-col border-l border-[var(--border)] pl-4">
          {flat
            ? entries.map((entry, index) => (
                <GroupToolRow
                  key={entry.id || `${entry.name}-${index}`}
                  entry={entry}
                  open={openId === entry.id}
                  onToggle={() => toggle(entry.id)}
                />
              ))
            : (() => {
                let offset = 0;
                return runs.map((run, ri) => {
                  const start = offset;
                  offset += run.length;
                  if (run.length === 1) {
                    const entry = run[0]!;
                    return (
                      <GroupToolRow
                        key={entry.id || `${entry.name}-${start}`}
                        entry={entry}
                        open={openId === entry.id}
                        onToggle={() => toggle(entry.id)}
                      />
                    );
                  }
                  return (
                    <RepeatSubGroup
                      key={`run-${ri}-${start}`}
                      entries={run}
                      startIndex={start}
                      openId={openId}
                      onToggle={toggle}
                    />
                  );
                });
              })()}
        </div>
      )}
    </div>
  );
}
