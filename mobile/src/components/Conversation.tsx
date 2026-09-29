import {
  ArrowDown,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DecisionPrompt } from "@egant/components/DecisionPrompt";
import { Markdown } from "@egant/components/Markdown";
import { ToolActivityGroup } from "@egant/components/ToolCards";
import {
  modeLabel,
  permissionSummary,
  prettyClaudeModelId,
  timeLabel,
  truncate,
} from "@egant/lib/transcript";
import type { AgentRequest, Entry, PendingPermission } from "@egant/lib/types";
import type { MobileSession } from "../api";
import { useMobile } from "../store";
import type { LoadedTranscript } from "../store";
import { AgentGlyph, BranchLine, ConnectionDot, StatusLine, agentLabel } from "./bits";
import { ConnectionBanner } from "./ConnectionBanner";
import { Toast } from "./Toast";

/** How close to the bottom still counts as "at the bottom" — the desktop's
 * own rule, so a streaming reply keeps the view pinned the same way. */
const STICK_PX = 80;

/** One conversation, the way the desktop stage draws it — narrower, with the
 * permission prompt docked above the composer where a thumb can reach it. */
export function Conversation({ id }: { id: number }) {
  const session = useMobile((s) => s.sessions.find((row) => row.id === id));
  const transcript = useMobile((s) => s.transcripts[id]);
  const loadError = useMobile((s) => s.transcriptErrors[id]);
  const machine = useMobile((s) => s.machineName);
  const navigate = useMobile((s) => s.navigate);
  const openTranscript = useMobile((s) => s.openTranscript);

  useEffect(() => {
    if (session?.kind !== "cli") void openTranscript(id);
  }, [id, session?.kind, openTranscript]);

  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <Header onBack={() => navigate(null)} title="Session" subtitle="" />
        <Centered>This session isn't on your Mac any more.</Centered>
      </div>
    );
  }

  const subtitle = `${session.projectName} @ ${machine} · ${agentLabel(session.agent, session.kind)}`;

  return (
    <div className="flex h-full flex-col">
      <Header
        onBack={() => navigate(null)}
        title={session.title}
        subtitle={subtitle}
        session={session}
      />
      <ConnectionBanner />
      {session.kind === "cli" ? (
        <CliNotice session={session} />
      ) : transcript ? (
        <Thread session={session} transcript={transcript} />
      ) : loadError ? (
        <Centered>
          <span className="text-[var(--danger)]">{loadError}</span>
          <button
            type="button"
            onClick={() => void openTranscript(id, true)}
            className="mt-3 cursor-pointer rounded-full bg-[var(--bubble)] px-4 py-2 text-[13px] text-[var(--ink)]"
          >
            Try again
          </button>
        </Centered>
      ) : (
        <Centered>
          <Loader2 size={18} strokeWidth={2} className="animate-spin text-[var(--faint)]" />
        </Centered>
      )}
    </div>
  );
}

function Header({
  onBack,
  title,
  subtitle,
  session,
}: {
  onBack: () => void;
  title: string;
  subtitle: string;
  session?: MobileSession;
}) {
  const connection = useMobile((s) => s.connection);
  return (
    <header className="safe-top shrink-0 border-b border-[var(--border)]">
      <div className="flex min-h-14 items-center gap-1 py-1.5 pr-4 pl-1">
        <button
          type="button"
          aria-label="Back to sessions"
          onClick={onBack}
          className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--muted)] active:bg-[var(--hover)]"
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {session && <AgentGlyph agent={session.agent} />}
            <span className="min-w-0 truncate text-[15px] font-medium text-[var(--ink)]">{title}</span>
          </div>
          {subtitle && (
            <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--faint)]">
              <span className="min-w-0 truncate">{subtitle}</span>
            </div>
          )}
          {session?.worktree && (
            <div className="mt-0.5">
              <BranchLine branch={session.branch} worktree={session.worktree} />
            </div>
          )}
        </div>
        <ConnectionDot connection={connection} />
      </div>
    </header>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center text-[13px] text-[var(--muted)]">
      {children}
    </div>
  );
}

/** A terminal session has no transcript to show: its CLI draws itself, in a
 * terminal, on the Mac. */
function CliNotice({ session }: { session: MobileSession }) {
  return (
    <Centered>
      <TerminalSquare size={22} strokeWidth={1.75} className="mb-3 text-[var(--faint)]" />
      <div className="text-[14px] text-[var(--ink)]">
        {agentLabel(session.agent, "chat")} runs in a terminal on your Mac
      </div>
      <div className="mt-1.5 max-w-[300px] leading-relaxed">
        This session is the agent's own CLI rather than a chat, so there's nothing to show or type
        into from here. Open it in egant on your Mac.
      </div>
    </Centered>
  );
}

function Thread({ session, transcript }: { session: MobileSession; transcript: LoadedTranscript }) {
  const loadOlder = useMobile((s) => s.loadOlder);
  const answerPermission = useMobile((s) => s.answerPermission);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const previousHeight = useRef(0);
  const olderPending = useRef(false);

  const busy = transcript.state === "running" || transcript.state === "awaiting_permission";
  const pendingList =
    transcript.pendingList ?? (transcript.pending != null ? [transcript.pending] : []);

  // Pinned to the bottom while the reader is there, never yanked back once
  // they scroll up — the desktop's rule. Every render, because a streaming
  // reply grows the column without adding an entry.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (olderPending.current) {
      // Earlier messages were put in above: keep what was on screen still.
      el.scrollTop += el.scrollHeight - previousHeight.current;
      olderPending.current = false;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    previousHeight.current = el.scrollHeight;
  });

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
            stickRef.current = near;
            if (near !== atBottom) setAtBottom(near);
          }}
          className="h-full overflow-y-auto overscroll-contain px-4 pt-3 pb-4"
        >
          <div className="mx-auto flex w-full max-w-[735px] flex-col gap-4">
            {transcript.start > 0 && (
              <button
                type="button"
                disabled={transcript.loadingOlder}
                onClick={() => {
                  olderPending.current = true;
                  previousHeight.current = scrollRef.current?.scrollHeight ?? 0;
                  void loadOlder(session.id);
                }}
                className="mx-auto flex cursor-pointer items-center gap-1.5 rounded-full bg-[var(--bubble)] px-3.5 py-1.5 text-[12px] text-[var(--muted)] disabled:opacity-60"
              >
                {transcript.loadingOlder && (
                  <Loader2 size={12} strokeWidth={2} className="animate-spin" />
                )}
                Earlier messages
              </button>
            )}
            <Entries sessionId={session.id} entries={transcript.entries} busy={busy} />
            {transcript.entries.length === 0 && !busy && (
              <div className="py-10 text-center text-[13px] text-[var(--faint)]">
                Nothing here yet. Send the first message.
              </div>
            )}
            {busy && (
              <div className="-mt-2">
                <StatusLine state={transcript.state} startedAt={transcript.turnStartedAt} />
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            aria-label="Jump to the latest"
            onClick={jumpToBottom}
            className="menu absolute right-4 bottom-3 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[var(--ink)]"
          >
            <ArrowDown size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      <div className="safe-bottom shrink-0 px-3 pt-1">
        <div className="mx-auto w-full max-w-[735px]">
          <Toast />
          {pendingList.length > 0 && (
            <PermissionSheet
              items={pendingList}
              onAnswer={(requestId, decision) =>
                void answerPermission(session.id, requestId, decision)
              }
            />
          )}
          <Composer session={session} transcript={transcript} />
        </div>
      </div>
    </>
  );
}

/** The transcript's entries, drawn the way the desktop draws them: user
 * turns as bubbles, replies as Markdown, consecutive tool calls folded into
 * one activity block — plus the agent's thinking, which a phone shows
 * collapsed rather than dropping. */
function Entries({
  sessionId,
  entries,
  busy,
}: {
  sessionId: number;
  entries: Entry[];
  busy: boolean;
}) {
  const decisionResponses = useMobile((s) => s.decisionResponses);
  const nodes: ReactNode[] = [];
  let i = 0;
  let previous: Entry | undefined;
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.kind === "tool") {
      let j = i + 1;
      while (j < entries.length && entries[j]!.kind === "tool") j++;
      nodes.push(
        <ToolActivityGroup
          key={`tools-${i}`}
          entries={entries.slice(i, j) as Extract<Entry, { kind: "tool" }>[]}
        />,
      );
      previous = entries[j - 1];
      i = j;
      continue;
    }
    // A decision answer goes to the agent as an ordinary turn, but the card
    // above already shows the pick — the desktop draws no bubble for it
    // either.
    const answeredCardAbove =
      previous?.kind === "agent_request" &&
      decisionResponses[`${sessionId}:${previous.id}`] != null;
    const hidden =
      (entry.kind === "user" && answeredCardAbove && entry.text.startsWith("Decision — ")) ||
      (entry.kind === "assistant" && !entry.streaming && entry.text.trim() === "") ||
      (entry.kind === "thinking" && !entry.streaming && entry.text.trim() === "");
    if (!hidden) {
      // Thinking is only live at the tail of a running turn: a transcript
      // saved by an older build can hold thinking still marked as streaming.
      const settled =
        entry.kind === "thinking" && entry.streaming && (!busy || i < entries.length - 1)
          ? { ...entry, streaming: false }
          : entry;
      nodes.push(<EntryView key={i} entry={settled} sessionId={sessionId} />);
    }
    if (entry.kind !== "thinking") previous = entry;
    i++;
  }
  return <>{nodes}</>;
}

function EntryView({ entry, sessionId }: { entry: Entry; sessionId: number }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex w-full justify-end">
          <div className="max-w-[85%] rounded-2xl bg-[var(--bubble)] px-4 py-2.5 text-[15px] leading-6 break-words whitespace-pre-wrap text-[var(--ink)]">
            {entry.text}
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          <Markdown text={entry.streaming ? `${entry.text}▌` : entry.text} />
          {!entry.streaming && entry.at !== undefined && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <span>{timeLabel(entry.at)}</span>
              <CopyButton text={entry.text} />
            </div>
          )}
        </div>
      );
    case "thinking":
      return <ThinkingRow entry={entry} />;
    case "tool":
      // Grouped by `Entries`; a lone call still arrives as a group of one.
      return null;
    case "agent_request":
      return <RequestCard sessionId={sessionId} id={entry.id} request={entry.request} />;
    case "notice":
      return (
        <div
          className={`w-full rounded-xl p-2.5 text-xs break-words whitespace-pre-wrap ${
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

/** The agent's reasoning: its live tail while it thinks, "Thought for 4s"
 * once it's done — either one opens to the whole text. */
function ThinkingRow({ entry }: { entry: Extract<Entry, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const seconds = entry.elapsedMs !== undefined ? Math.max(1, Math.round(entry.elapsedMs / 1000)) : null;
  const label = entry.streaming ? "Thinking" : seconds != null ? `Thought for ${seconds}s` : "Thought";
  const text = entry.text.trim();
  const tail = text.length > 280 ? `…${text.slice(-280)}` : text;
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 self-start text-[13px] text-[var(--muted)]"
      >
        <Brain size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        <span className={entry.streaming ? "shimmer" : ""}>{label}</span>
        {text &&
          (open ? (
            <ChevronDown size={12} strokeWidth={2} className="text-[var(--faint)]" />
          ) : (
            <ChevronRight size={12} strokeWidth={2} className="text-[var(--faint)]" />
          ))}
      </button>
      {text && (open || entry.streaming) && (
        <div className="border-l-2 border-[var(--border)] pl-3 text-[12.5px] leading-5 break-words whitespace-pre-wrap text-[var(--faint)]">
          {open ? text : tail}
        </div>
      )}
    </div>
  );
}

function RequestCard({
  sessionId,
  id,
  request,
}: {
  sessionId: number;
  id: string;
  request: AgentRequest;
}) {
  const response = useMobile((s) => s.decisionResponses[`${sessionId}:${id}`] ?? null);
  const answerDecision = useMobile((s) => s.answerDecision);
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
      aria-label="Copy reply"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      className="cursor-pointer rounded-sm p-1"
    >
      {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
    </button>
  );
}

/** Every outstanding permission request, docked above the composer: what the
 * agent wants to do, and Allow once / Allow always / Deny. "Allow always"
 * flips the whole session to Bypass permissions on the Mac, so it asks
 * first. */
function PermissionSheet({
  items,
  onAnswer,
}: {
  items: PendingPermission[];
  onAnswer: (requestId: string, decision: "allow" | "allow-always" | "deny") => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="composer mb-2 flex max-h-[45vh] flex-col gap-2 overflow-y-auto rounded-2xl p-3">
      <div className="flex items-baseline gap-2">
        <div className="text-[14px] text-[var(--ink)]">
          {items.length === 1 ? "Permission needed" : `${items.length} permissions needed`}
        </div>
        <div className="text-[11px] text-[var(--faint)]">Nothing runs until you answer</div>
      </div>
      {items.map((pending) => (
        <div
          key={pending.requestId}
          className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-2.5"
        >
          <div className="flex min-w-0 items-start gap-2">
            <span className="shrink-0 rounded-md bg-[var(--bubble)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink)]">
              {pending.toolName}
            </span>
            <span className="min-w-0 flex-1 font-mono text-[12px] leading-5 break-all text-[var(--muted)]">
              {truncate(permissionSummary(pending.input), 400)}
            </span>
          </div>
          {confirming === pending.requestId ? (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] leading-relaxed text-[var(--muted)]">
                Allow always also switches this session to Bypass permissions — it won't ask again
                for anything.
              </div>
              <div className="flex gap-2">
                <SheetButton primary onClick={() => onAnswer(pending.requestId, "allow-always")}>
                  Allow always
                </SheetButton>
                <SheetButton onClick={() => setConfirming(null)}>Cancel</SheetButton>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <SheetButton primary onClick={() => onAnswer(pending.requestId, "allow")}>
                Allow once
              </SheetButton>
              <SheetButton onClick={() => setConfirming(pending.requestId)}>Allow always</SheetButton>
              <SheetButton quiet onClick={() => onAnswer(pending.requestId, "deny")}>
                Deny
              </SheetButton>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SheetButton({
  children,
  onClick,
  primary,
  quiet,
}: {
  children: ReactNode;
  onClick: () => void;
  primary?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 flex-1 cursor-pointer rounded-full px-3 text-[13px] ${
        primary
          ? "bg-[#f2f2f5] text-[#0c0c0e]"
          : quiet
            ? "bg-transparent text-[var(--muted)]"
            : "bg-[var(--bubble)] text-[var(--ink)]"
      } active:opacity-80`}
    >
      {children}
    </button>
  );
}

/** The docked composer. Return makes a new line on a phone keyboard; the disc
 * sends — and turns into Stop while the agent is working. */
function Composer({ session, transcript }: { session: MobileSession; transcript: LoadedTranscript }) {
  const send = useMobile((s) => s.send);
  const interrupt = useMobile((s) => s.interrupt);
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  // Grows with the message, up to a few lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  const busy = transcript.state === "running" || transcript.state === "awaiting_permission";
  // The desktop composer's rule: an ended session the agent recorded a
  // conversation id for is resumed by the next message; only one that never
  // got that far is really over.
  const ended = session.ended && transcript.sessionId == null;
  const hasText = text.trim().length > 0;

  const submit = () => {
    if (!hasText || ended) return;
    void send(session.id, text);
    setText("");
  };

  const model = transcript.model ?? session.model;
  const modelName = model
    ? session.agent === "claude"
      ? prettyClaudeModelId(model)
      : model
    : null;

  return (
    <div className="pb-1">
      <div className="composer flex items-end gap-2 rounded-[22px] py-1.5 pr-1.5 pl-4">
        <textarea
          ref={area}
          value={text}
          rows={1}
          disabled={ended}
          onChange={(e) => setText(e.target.value)}
          placeholder={ended ? "This session has ended" : "Message the agent…"}
          className="block max-h-[150px] min-h-[36px] w-full resize-none bg-transparent py-1.5 text-[16px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
        />
        {busy && (
          <button
            type="button"
            aria-label="Stop the agent"
            onClick={() => void interrupt(session.id)}
            className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f2f2f5] text-[#0c0c0e] active:opacity-80"
          >
            <Square size={12} strokeWidth={2} fill="currentColor" />
          </button>
        )}
        {(!busy || hasText) && (
          <button
            type="button"
            aria-label="Send"
            aria-disabled={!hasText || ended}
            onClick={submit}
            className={`flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f2f2f5] text-[#0c0c0e] active:opacity-80 ${
              !hasText || ended ? "opacity-40" : ""
            }`}
          >
            <ArrowUp size={17} strokeWidth={2.5} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[11px] text-[var(--faint)]">
        <span>{modeLabel(session.permissionMode)}</span>
        {modelName && (
          <>
            <span>·</span>
            <span className="min-w-0 truncate">{modelName}</span>
          </>
        )}
      </div>
    </div>
  );
}
