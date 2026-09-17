import { Check, Copy, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { permissionSummary, timeLabel, truncate } from "../lib/transcript";
import type { Entry, PendingPermission } from "../lib/types";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { StatusLine } from "./StatusLine";
import { groupEntries, ReadGroupCard, ToolCard } from "./ToolCards";

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
  // Reasoning is dropped rather than drawn. The status line at the tail
  // already says the turn is thinking, and once the answer is there a
  // scrollback of settled "Thought for 4s" rows is just noise between the
  // things that actually happened. Filtered here rather than in `RenderEntry`
  // so the grouping below never sees one either — an entry that renders
  // nothing would still split two neighbouring Reads into separate cards, for
  // a reason invisible on screen.
  const entries = (transcript?.entries ?? []).filter((entry) => entry.kind !== "thinking");
  const pending = transcript?.pending;

  // The status line at the tail of the transcript covers the whole turn — the
  // gap before the first token included — so there is never a stretch of the
  // wait with nothing on screen accounting for it.
  const busy = transcript?.state === "running" || transcript?.state === "awaiting_permission";

  // Stay pinned to the bottom while the user is already there; never yank them
  // back once they scroll up to read. Deliberately every render rather than on
  // a dependency list: a streaming reply grows the column without changing the
  // entry count, and the status line trailing it has to stay in view too.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

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
        className="rise flex flex-1 items-start justify-center overflow-y-auto px-6 pt-4 pb-2"
        style={{ animationDelay: "90ms" }}
      >
        <div className="flex w-full max-w-[735px] flex-col gap-5">
          {groupEntries(entries).map((item) =>
            item.kind === "read-group" ? (
              <ReadGroupCard key={item.index} entries={item.entries} />
            ) : (
              <RenderEntry key={item.index} entry={item.entry} />
            ),
          )}
          {pending && (
            <PermissionCard
              pending={pending}
              onAllow={() => void answerPermission(active.id, true)}
              onDeny={() => void answerPermission(active.id, false)}
            />
          )}
          {/* Trailing the transcript, the way Claude Code puts it: directly
            under the text still being generated rather than docked to the
            composer. The pull-up trims the column's own gap so it reads as
            part of the reply above it, not as a separate block. */}
          {busy && transcript && (
            <div className="-mt-2.5">
              <StatusLine state={transcript.state} startedAt={transcript.turnStartedAt} />
            </div>
          )}
        </div>
      </div>

      <div className="rise flex w-full shrink-0 flex-col items-center px-6 pb-2">
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

    // Never reached — `TranscriptView` filters these out before grouping. The
    // case stays so the switch is still exhaustive over `Entry`, and so the
    // next person sees where reasoning went.
    case "thinking":
      return null;

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
