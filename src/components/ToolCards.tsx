import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
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
import { languageFor } from "./FileView";

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

/** Path header above a dropdown's code, like the screenshot: the full path on
 * the left, a copy button on the right. */
function BodyHeader({ path, copyText }: { path?: string; copyText?: string }) {
  if (!path && !copyText) return null;
  return (
    <div className="flex items-center gap-2">
      {path ? (
        <div title={path} className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--faint)]">
          {path}
        </div>
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

/** One run inside a command group: `Ran npx tsc… ∨`, the `$` pill, then the
 * output as plain text — or `(Bash completed with no output)` when it ran
 * silent. */
function CommandRow({ entry }: { entry: ToolEntry }) {
  const [expanded, setExpanded] = useState(true);
  const command = toolCommand(entry.input);
  const snippet = commandSnippet(entry);
  const output = entry.output == null ? null : truncate(entry.output, 4000);
  const busy = entry.output == null && !entry.isError;
  const empty = output != null && output.trim() === "";
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
      {expanded && (
        <>
          {command ? (
            <BashPill command={truncate(command, 2000)} />
          ) : null}
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
      )}
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
