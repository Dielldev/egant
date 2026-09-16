import { ChevronDown, ChevronRight, FilePen, FilePlus2, FileSearch, Terminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { basename, normalizeEdit, stripLineNumbers, toolSummary, truncate } from "../lib/transcript";
import type { Entry } from "../lib/types";
import { AddedLinesView, DiffView } from "./DiffView";

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** The collapsible chrome every tool card shares: an icon, a title line with
 * an optional subtitle, a busy/error status dot, and a chevron that toggles
 * the body. Each card picks its own `defaultExpanded` — Read stays quiet
 * until asked, Edit/Write open with the payload the user actually wants. */
function ToolCardShell({
  icon,
  title,
  subtitle,
  busy,
  error,
  defaultExpanded,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  busy?: boolean;
  error?: boolean;
  defaultExpanded: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasBody = children != null;

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[rgba(255,255,255,0.03)] p-2.5">
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        className={`flex items-center gap-2 text-xs text-[var(--muted)] ${hasBody ? "cursor-pointer" : "cursor-default"}`}
      >
        <span className="shrink-0 text-[var(--faint)]">{icon}</span>
        <span className="shrink-0 text-[var(--ink)]">{title}</span>
        {subtitle && <span className="flex-1 truncate text-left">{subtitle}</span>}
        {!subtitle && <span className="flex-1" />}
        {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
        {error && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />}
        {hasBody &&
          (expanded ? (
            <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
          ) : (
            <ChevronRight size={12} strokeWidth={2} className="shrink-0" />
          ))}
      </button>
      {expanded && children}
    </div>
  );
}

/** The generic fallback every tool card used to be: name, first identifying
 * argument, and the raw truncated output. Still used for Bash, Grep, Glob,
 * WebFetch, TodoWrite, and anything an error short-circuits into. */
function GenericToolCard({ entry }: { entry: ToolEntry }) {
  return (
    <ToolCardShell
      icon={<Terminal size={12} strokeWidth={2} />}
      title={entry.name}
      subtitle={toolSummary(entry.input, entry.name)}
      busy={entry.output == null}
      error={entry.isError}
      defaultExpanded={entry.output != null}
    >
      {entry.output != null && (
        <div
          className={`max-h-[200px] overflow-y-auto text-xs whitespace-pre-wrap ${
            entry.isError ? "text-[var(--danger)]" : "text-[var(--faint)]"
          }`}
        >
          {truncate(entry.output, 4000)}
        </div>
      )}
    </ToolCardShell>
  );
}

function ReadToolCard({ entry }: { entry: ToolEntry }) {
  if (entry.isError) return <GenericToolCard entry={entry} />;
  const record = (entry.input ?? {}) as Record<string, unknown>;
  const filePath = typeof record.file_path === "string" ? record.file_path : "";

  return (
    <ToolCardShell
      icon={<FileSearch size={12} strokeWidth={2} />}
      title={`Read ${basename(filePath) || "file"}`}
      subtitle={filePath}
      busy={entry.output == null}
      defaultExpanded={false}
    >
      {entry.output != null && (
        <div className="max-h-[240px] overflow-y-auto rounded-lg bg-[rgba(0,0,0,0.15)] p-2 font-mono text-[11px] leading-5 whitespace-pre text-[var(--faint)]">
          {truncate(stripLineNumbers(entry.output), 4000)}
        </div>
      )}
    </ToolCardShell>
  );
}

function WriteToolCard({ entry }: { entry: ToolEntry }) {
  if (entry.isError) return <GenericToolCard entry={entry} />;
  const record = (entry.input ?? {}) as Record<string, unknown>;
  const filePath = typeof record.file_path === "string" ? record.file_path : "";
  const content = typeof record.content === "string" ? record.content : "";

  return (
    <ToolCardShell
      icon={<FilePlus2 size={12} strokeWidth={2} />}
      title={`Write ${basename(filePath) || "file"}`}
      subtitle={filePath}
      busy={entry.output == null}
      defaultExpanded={true}
    >
      <AddedLinesView text={truncate(content, 4000)} />
    </ToolCardShell>
  );
}

const MAX_RENDERED_EDITS = 20;

function EditToolCard({ entry }: { entry: ToolEntry }) {
  if (entry.isError) return <GenericToolCard entry={entry} />;
  const { filePath, edits } = normalizeEdit(entry.name, entry.input);
  const shown = edits.slice(0, MAX_RENDERED_EDITS);
  const hidden = edits.length - shown.length;

  return (
    <ToolCardShell
      icon={<FilePen size={12} strokeWidth={2} />}
      title={`Edit ${basename(filePath) || "file"}`}
      subtitle={edits.length > 1 ? `${edits.length} edits` : filePath}
      busy={entry.output == null}
      defaultExpanded={true}
    >
      <div className="flex flex-col gap-1.5">
        {shown.map((edit, index) => (
          <DiffView key={index} oldText={edit.old_string} newText={edit.new_string} />
        ))}
        {hidden > 0 && (
          <div className="text-xs text-[var(--faint)]">
            + {hidden} more edit{hidden === 1 ? "" : "s"}
          </div>
        )}
      </div>
    </ToolCardShell>
  );
}

/** Dispatches a tool-call entry to its specialized card by tool name, falling
 * back to the generic card for anything that isn't Read/Write/Edit/MultiEdit
 * — including a name that doesn't match exactly, so this is safe against any
 * future or unexpected tool. */
export function ToolCard({ entry }: { entry: ToolEntry }) {
  switch (entry.name) {
    case "Read":
      return <ReadToolCard entry={entry} />;
    case "Write":
      return <WriteToolCard entry={entry} />;
    case "Edit":
    case "MultiEdit":
      return <EditToolCard entry={entry} />;
    default:
      return <GenericToolCard entry={entry} />;
  }
}
