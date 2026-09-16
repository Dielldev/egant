import { Check, ChevronDown, ChevronRight, Copy, FolderOpen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { emptyUsage, permissionSummary, timeLabel, truncate } from "../lib/transcript";
import type { Entry, PendingPermission } from "../lib/types";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { ContextMeter } from "./ContextMeter";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCards";

/** The stage's content: the conversation, and the composer that drives it.
 * Reads the active session's transcript mirror on render, which is what makes
 * streaming free — each `session-event` folds into the store and this
 * re-renders. */
export function TranscriptView() {
  const snapshot = useEgant((s) => s.snapshot);
  const transcripts = useEgant((s) => s.transcripts);
  const openFolderDialog = useEgant((s) => s.openFolderDialog);
  const answerPermission = useEgant((s) => s.answerPermission);
  const error = useEgant((s) => s.error);
  const dismissError = useEgant((s) => s.dismissError);

  const activeId = snapshot?.activeSession;
  const active = snapshot?.sessions.find((s) => s.id === activeId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const transcript = activeId != null ? transcripts[activeId] : undefined;
  const entries = transcript?.entries ?? [];
  const pending = transcript?.pending;

  // The gap between "user hit send" and the first delta/tool call has no
  // entry to show yet — a dedicated indicator fills it instead of leaving
  // the transcript looking stalled.
  const lastEntry = entries[entries.length - 1];
  const awaitingFirstToken =
    transcript?.state === "running" &&
    !pending &&
    !(lastEntry?.kind === "assistant" && lastEntry.streaming) &&
    !(lastEntry?.kind === "thinking" && lastEntry.streaming) &&
    !(lastEntry?.kind === "tool" && lastEntry.output == null);

  // Stay pinned to the bottom while the user is already there; never yank them
  // back once they scroll up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, pending, transcript?.state, activeId]);

  if (!snapshot) return <div className="size-full" />;

  if (snapshot.projects.length === 0) {
    return (
      <Centered
        title="No folder open"
        detail="Point egant at a project to start an agent session."
        actionLabel="Open a folder"
        onAction={() => void openFolderDialog()}
      />
    );
  }

  if (!active) return <Centered title="No conversation open" detail="Press ⌘N to start one" />;

  return (
    <div className="flex size-full flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex flex-1 items-start justify-center overflow-y-auto px-6 pt-4 pb-2"
      >
        <div className="flex w-full max-w-[735px] flex-col gap-5">
          {entries.map((entry, index) => (
            <RenderEntry key={index} entry={entry} />
          ))}
          {awaitingFirstToken && <ThinkingIndicator />}
          {pending && (
            <PermissionCard
              pending={pending}
              onAllow={() => void answerPermission(active.id, true)}
              onDeny={() => void answerPermission(active.id, false)}
            />
          )}
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col items-center px-6 pb-2">
        <div className="flex w-full max-w-[735px] flex-col">
          {error && (
            <button
              type="button"
              title="Dismiss"
              onClick={dismissError}
              className="mb-2 w-full cursor-pointer truncate rounded-lg bg-[rgba(224,112,112,0.14)] px-3 py-1.5 text-left text-xs text-[var(--danger)]"
            >
              {error}
            </button>
          )}
          <Composer sessionId={active.id} />
          {/* The one thing the old status bar carried that the window still
            needs: how much room is left in the conversation. */}
          <div className="flex h-[22px] w-full items-center justify-end pr-1">
            <ContextMeter
              usage={transcript?.usage ?? emptyUsage()}
              costUsd={transcript?.totalCostUsd ?? 0}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1">
      <div className="text-sm text-[var(--muted)]">{title}</div>
      <div className="text-xs text-[var(--faint)]">{detail}</div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 flex cursor-pointer items-center gap-1.5 rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] hover:opacity-85"
        >
          <FolderOpen size={14} strokeWidth={2} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function RenderEntry({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    // The user's turn is a right-aligned bubble; the agent's is plain text on
    // the stage. One of the two has to be the ground, and there is far more
    // agent output than user input.
    case "user":
      return (
        <div className="flex w-full justify-end">
          <div className="max-w-[80%] rounded-2xl bg-[var(--bubble)] px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap text-[var(--ink)]">
            {entry.text}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex w-full flex-col gap-1.5">
          {/* The trailing block is the "still typing" cue — appended to the
            source text so it rides along inside whatever markdown element
            (paragraph, code fence) is still streaming in. */}
          <Markdown text={entry.streaming ? `${entry.text}▌` : entry.text} />
          {/* The footer is what marks a reply as finished, so it waits for the
            stream to settle. */}
          {!entry.streaming && entry.at !== undefined && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <span>{timeLabel(entry.at)}</span>
              <CopyButton text={entry.text} />
            </div>
          )}
        </div>
      );

    case "thinking":
      return <ThinkingEntry entry={entry} />;

    case "tool":
      return <ToolCard entry={entry} />;

    case "notice":
      return (
        <div
          className={`w-full rounded-xl p-2.5 text-xs whitespace-pre-wrap ${
            entry.isError
              ? "bg-[rgba(224,112,112,0.14)] text-[var(--danger)]"
              : "bg-[rgba(255,255,255,0.05)] text-[var(--muted)]"
          }`}
        >
          {entry.text}
        </div>
      );
  }
}

/** A collapsible "Thinking" block. Opens on its own while the model is
 * actively reasoning, then stays wherever the user leaves it once the block
 * settles — no auto-collapse timer, just a toggle. */
function ThinkingEntry({ entry }: { entry: Extract<Entry, { kind: "thinking" }> }) {
  const [expanded, setExpanded] = useState(entry.streaming);

  return (
    <div className="flex w-full flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--faint)]"
      >
        <Sparkles size={12} strokeWidth={2} />
        <span>{entry.streaming ? "Thinking…" : "Thinking"}</span>
        {expanded ? (
          <ChevronDown size={12} strokeWidth={2} />
        ) : (
          <ChevronRight size={12} strokeWidth={2} />
        )}
      </button>
      {expanded && (
        <div className="w-full pl-[18px] text-xs leading-5 whitespace-pre-wrap text-[var(--faint)] italic">
          {entry.streaming ? `${entry.text}▌` : entry.text}
        </div>
      )}
    </div>
  );
}

/** Fills the gap between "user hit send" and the first token or tool call —
 * otherwise the transcript looks stalled with no feedback at all. */
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 px-0.5">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--busy)]" />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--busy)]"
        style={{ animationDelay: "0.15s" }}
      />
      <span
        className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--busy)]"
        style={{ animationDelay: "0.3s" }}
      />
    </div>
  );
}

/** Confirms in place rather than with a toast: the check is where the click
 * was, and it falls back to the copy icon on its own. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title="Copy reply"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      className="cursor-pointer rounded-sm p-0.5 hover:text-[var(--ink)]"
    >
      {copied ? (
        <Check size={12} strokeWidth={2} />
      ) : (
        <Copy size={12} strokeWidth={2} />
      )}
    </button>
  );
}

function PermissionCard({
  pending,
  onAllow,
  onDeny,
}: {
  pending: PendingPermission;
  onAllow: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="composer flex w-full flex-col gap-2 rounded-xl p-3">
      <div className="text-sm text-[var(--ink)]">Allow {pending.toolName}?</div>
      <div className="text-xs whitespace-pre-wrap text-[var(--muted)]">
        {truncate(permissionSummary(pending.input), 400)}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onAllow}
          className="cursor-pointer rounded-full bg-[#f2f2f5] px-3.5 py-1 text-xs text-[#0c0c0e] hover:opacity-85"
        >
          Allow
        </button>
        <button
          type="button"
          onClick={onDeny}
          className="cursor-pointer rounded-full bg-[rgba(255,255,255,0.1)] px-3.5 py-1 text-xs text-[var(--ink)] hover:opacity-85"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
