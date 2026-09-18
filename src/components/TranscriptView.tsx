import { Check, Copy, FolderOpen, List } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { permissionSummary, timeLabel, truncate } from "../lib/transcript";
import type { AgentRequest, Entry, PendingPermission } from "../lib/types";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { DecisionPrompt } from "./DecisionPrompt";
import { Markdown } from "./Markdown";
import { RunPill } from "./RunPill";
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

  // The error toast above the composer auto-dismisses: a sticky red bar that
  // has to be clicked away reads as a crash, while most store errors are
  // transient (a failed send, a blip mid-answer). It stays long enough to
  // read, then goes on its own — clicking still dismisses it sooner.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => dismissError(), 5000);
    return () => clearTimeout(timer);
  }, [error, dismissError]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const promptRefs = useRef(new Map<number, HTMLDivElement | null>());
  const [activePrompt, setActivePrompt] = useState<number | null>(null);

  const transcript = activeId != null ? transcripts[activeId] : undefined;
  // Reasoning is dropped rather than drawn. The status line at the tail
  // already says the turn is thinking, and once the answer is there a
  // scrollback of settled "Thought for 4s" rows is just noise between the
  // things that actually happened. Filtered here rather than in `RenderEntry`
  // so the grouping below never sees one either — an entry that renders
  // nothing would still split two neighbouring Reads into separate cards, for
  // a reason invisible on screen.
  const entries = (transcript?.entries ?? []).filter((entry) => entry.kind !== "thinking");
  // The approval table: every outstanding request, oldest first. Older
  // snapshots carry only `pending` — mirror it so the table still renders.
  const pendingList =
    transcript?.pendingList ??
    (transcript?.pending != null ? [transcript.pending] : []);

  // The status line at the tail of the transcript covers the whole turn — the
  // gap before the first token included — so there is never a stretch of the
  // wait with nothing on screen accounting for it.
  const busy = transcript?.state === "running" || transcript?.state === "awaiting_permission";

  // Chat outline: one stop per user prompt, in send order. Memoized off the
  // raw transcript entries (not the filtered `entries` above) so a streaming
  // assistant reply — a new array every token — doesn't rebuild it.
  const prompts = useMemo(() => {
    const source = transcript?.entries ?? [];
    const out: { entryIndex: number; n: number; text: string }[] = [];
    // `entries` drops `thinking` rows, so indices shift by that count. Walk
    // the filtered list for text but resolve back to the same numbering the
    // outline anchors use below (position among rendered entries).
    const visible = source.filter((entry) => entry.kind !== "thinking");
    visible.forEach((entry, entryIndex) => {
      if (entry.kind === "user") {
        out.push({ entryIndex, n: out.length + 1, text: entry.text });
      }
    });
    return out;
  }, [transcript?.entries]);
  const showOutline = prompts.length > 2;

  const jumpToPrompt = (entryIndex: number) => {
    const el = promptRefs.current.get(entryIndex);
    if (!el) return;
    // Leaving the tail breaks the pin on purpose — the stick effect would
    // otherwise yank a jump-to-#1 straight back to the bottom on next render.
    // The scroll handler re-arms it once the user returns to the bottom.
    stickRef.current = false;
    setActivePrompt(entryIndex);
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Marks the prompt nearest the top of the viewport as active while reading.
  // An observer (not the scroll handler) so streaming growth doesn't thrash
  // it — only actual crossings flip the highlight.
  useEffect(() => {
    if (!showOutline) return;
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (observed) => {
        const visible = observed
          .filter((o) => o.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0];
        const index = top?.target.getAttribute("data-prompt-index");
        if (index != null) setActivePrompt(Number(index));
      },
      { root, rootMargin: "-72px 0px -65% 0px", threshold: 0 },
    );
    promptRefs.current.forEach((el) => {
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [showOutline, prompts, activeId]);

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
    <div className="relative flex size-full flex-col">
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
            ) : item.entry.kind === "user" ? (
              <div
                key={item.index}
                ref={(el) => {
                  if (el) promptRefs.current.set(item.index, el);
                  else promptRefs.current.delete(item.index);
                }}
                data-prompt-index={item.index}
                className="scroll-mt-6"
              >
                <RenderEntry entry={item.entry} sessionId={active.id} />
              </div>
            ) : (
              <RenderEntry key={item.index} entry={item.entry} sessionId={active.id} />
            ),
          )}
          {pendingList.length > 0 && (
            <PermissionTable
              items={pendingList}
              onAnswer={(requestId, decision) =>
                void answerPermission(active.id, requestId, decision)
              }
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
          {/* The task is done — offer to run what it just changed, in the
            checkout it changed it in. A worktree session's work isn't in the
            folder you opened, so the pill names the branch it runs on. */}
          {!busy && transcript && entries.length > 0 && (
            <div className="-mt-1">
              <RunPill cwd={active.cwd} worktree={active.worktree} />
            </div>
          )}
        </div>
      </div>

      {showOutline && (
        <ChatOutline prompts={prompts} activeEntryIndex={activePrompt} onJump={jumpToPrompt} />
      )}

      <div className="rise flex w-full shrink-0 flex-col items-center px-6 pb-2">
        <div className="flex w-full max-w-[735px] flex-col">
          {error && (
            <button
              type="button"
              title="Dismiss"
              onClick={dismissError}
              className="row-in mb-2 w-full cursor-pointer truncate rounded-lg bg-[rgba(224,112,112,0.14)] px-3 py-1.5 text-left text-xs text-[var(--danger)]"
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

/** First line of a prompt, single-spaced, for outline rows and tooltips. */
function outlinePreview(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** Chat outline + conversation navigation: one stop per user prompt, shown
 * once there are more than two to jump between. Hovering a stop names the
 * prompt it points at; clicking smooth-scrolls the transcript to it. The
 * full card shows on wide windows; a compact dot rail takes over below `xl`
 * so it never covers the bubbles it navigates. */
function ChatOutline({
  prompts,
  activeEntryIndex,
  onJump,
}: {
  prompts: { entryIndex: number; n: number; text: string }[];
  activeEntryIndex: number | null;
  onJump: (entryIndex: number) => void;
}) {
  const active = activeEntryIndex ?? prompts[prompts.length - 1]?.entryIndex ?? null;

  return (
    <>
      {/* Full outline card — wide windows only. */}
      <nav
        aria-label="Chat outline"
        className="menu absolute top-4 right-3 z-20 hidden w-44 flex-col gap-1 rounded-xl p-2 opacity-80 transition-opacity hover:opacity-100 xl:flex"
      >
        <div className="flex items-center gap-1.5 px-1.5 pt-0.5 pb-1 text-[11px] text-[var(--faint)]">
          <List size={12} strokeWidth={2} />
          <span className="flex-1">Outline</span>
          <span className="rounded-full bg-[var(--bubble)] px-1.5 text-[10px] text-[var(--muted)]">
            {prompts.length}
          </span>
        </div>
        <div className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
          {prompts.map((prompt) => {
            const isActive = prompt.entryIndex === active;
            const hoverLabel = `Prompt ${prompt.n}: ${outlinePreview(prompt.text, 200)}`;
            return (
              <div key={prompt.entryIndex} className="group relative">
                <button
                  type="button"
                  title={hoverLabel}
                  aria-label={`Go to prompt ${prompt.n}`}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onJump(prompt.entryIndex)}
                  className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[11px] transition-colors ${
                    isActive
                      ? "bg-[var(--selected)] text-[var(--ink)]"
                      : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                      isActive
                        ? "bg-[var(--bubble)] text-[var(--ink)]"
                        : "bg-[var(--hover)] text-[var(--faint)]"
                    }`}
                  >
                    {prompt.n}
                  </span>
                  <span className="flex-1 truncate">
                    {outlinePreview(prompt.text, 42) || `Prompt ${prompt.n}`}
                  </span>
                </button>
                {/* Hover card: which prompt this stop is, in full. */}
                <div className="pointer-events-none absolute top-1/2 right-full z-30 mr-2 hidden w-60 -translate-y-1/2 group-hover:block">
                  <div className="menu rounded-lg p-2">
                    <div className="mb-0.5 text-[11px] font-medium text-[var(--ink)]">
                      Prompt {prompt.n}
                    </div>
                    <div className="line-clamp-4 text-[11px] leading-5 whitespace-pre-wrap text-[var(--muted)]">
                      {outlinePreview(prompt.text, 280)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </nav>

      {/* Compact dot rail — narrow windows. Same stops, same tooltips. */}
      <nav
        aria-label="Chat outline"
        className="menu absolute top-16 right-2 z-20 flex flex-col items-center gap-1 rounded-full px-1.5 py-2 opacity-70 transition-opacity hover:opacity-100 xl:hidden"
      >
        {prompts.map((prompt) => {
          const isActive = prompt.entryIndex === active;
          const hoverLabel = `Prompt ${prompt.n}: ${outlinePreview(prompt.text, 200)}`;
          return (
            <div key={prompt.entryIndex} className="group relative">
              <button
                type="button"
                title={hoverLabel}
                aria-label={`Go to prompt ${prompt.n}`}
                aria-current={isActive ? "true" : undefined}
                onClick={() => onJump(prompt.entryIndex)}
                className={`cursor-pointer rounded-full transition-all ${
                  isActive
                    ? "h-4 w-2 bg-[var(--ink)]"
                    : "h-2 w-2 bg-[var(--faint)] hover:bg-[var(--muted)]"
                }`}
              />
              <div className="pointer-events-none absolute top-1/2 right-full z-30 mr-2 hidden w-56 -translate-y-1/2 group-hover:block">
                <div className="menu rounded-lg p-2">
                  <div className="mb-0.5 text-[11px] font-medium text-[var(--ink)]">
                    Prompt {prompt.n}
                  </div>
                  <div className="line-clamp-4 text-[11px] leading-5 whitespace-pre-wrap text-[var(--muted)]">
                    {outlinePreview(prompt.text, 280)}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </nav>
    </>
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

function RenderEntry({ entry, sessionId }: { entry: Entry; sessionId: number }) {
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

    case "agent_request":
      return <AgentRequestCard sessionId={sessionId} id={entry.id} request={entry.request} />;

    case "notice":
      return (
        <div
          className={`w-full rounded-xl p-2.5 text-xs whitespace-pre-wrap ${
            entry.isError
              ? "bg-[rgba(224,112,112,0.14)] text-[var(--danger)]"
              : "bg-[var(--card)] text-[var(--muted)]"
          }`}
        >
          {entry.text}
        </div>
      );
  }
}

/** Dispatches an `agent_request` entry to the card for its kind, and wires
 * its answer to the store — the one place a request's `type` decides which
 * component renders it. A future request kind (confirmation, text input, a
 * tool-approval prompt…) adds its own card and a case here; nothing upstream
 * of this function needs to know the difference. */
function AgentRequestCard({
  sessionId,
  id,
  request,
}: {
  sessionId: number;
  id: string;
  request: AgentRequest;
}) {
  const response = useEgant((s) => s.decisionResponses[`${sessionId}:${id}`] ?? null);
  const answerDecision = useEgant((s) => s.answerDecision);

  switch (request.type) {
    case "decision":
      return (
        <DecisionPrompt
          prompt={request}
          response={response}
          onSubmit={(answer) => void answerDecision(sessionId, request, answer)}
        />
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

/** One table row per outstanding request, like other agent apps: what the
 * agent wants, the exact resource, and Allow once / Allow always / Deny.
 * Allow on a turn-based wire (opencode) retries the turn with auto-approve;
 * on a live wire (Claude) it answers mid-turn. Deny just dismisses. */
function PermissionTable({
  items,
  onAnswer,
}: {
  items: PendingPermission[];
  onAnswer: (requestId: string, decision: "allow" | "allow-always" | "deny") => void;
}) {
  return (
    <div className="composer flex w-full flex-col gap-2 rounded-xl p-3">
      <div className="flex items-baseline gap-2">
        <div className="text-sm text-[var(--ink)]">
          {items.length === 1 ? "Permission needed" : `${items.length} permissions needed`}
        </div>
        <div className="text-[11px] text-[var(--faint)]">
          Nothing runs until you answer
        </div>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {items.map((pending) => (
          <div
            key={pending.requestId}
            className="flex w-full flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5"
          >
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded-md bg-[var(--bubble)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink)]">
                {pending.toolName}
              </span>
              <span className="flex-1 truncate text-xs text-[var(--muted)]">
                {truncate(permissionSummary(pending.input), 200)}
              </span>
            </div>
            {(pending.patterns?.length > 0 || pending.alwaysPatterns?.length > 0) && (
              <div className="font-mono text-[11px] text-[var(--faint)]">
                {[...(pending.patterns ?? []), ...(pending.alwaysPatterns ?? [])]
                  .filter((p, i, all) => p && all.indexOf(p) === i)
                  .slice(0, 3)
                  .join("  ·  ")}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onAnswer(pending.requestId, "allow")}
                className="cursor-pointer rounded-full bg-[#f2f2f5] px-3 py-1 text-xs text-[#0c0c0e] hover:opacity-85"
              >
                Allow once
              </button>
              <button
                type="button"
                title={
                  pending.alwaysPatterns?.length > 0
                    ? `Remember ${pending.alwaysPatterns.join(", ")}`
                    : "Remember this approval for the rest of the run"
                }
                onClick={() => onAnswer(pending.requestId, "allow-always")}
                className="cursor-pointer rounded-full bg-[var(--bubble)] px-3 py-1 text-xs text-[var(--ink)] hover:opacity-85"
              >
                Allow always
              </button>
              <button
                type="button"
                onClick={() => onAnswer(pending.requestId, "deny")}
                className="cursor-pointer rounded-full bg-transparent px-3 py-1 text-xs text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
