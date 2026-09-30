import {
  ArrowDown,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderGit2,
  GitBranch,
  Loader2,
  Shield,
  ShieldOff,
  SquarePen,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DecisionPrompt } from "@egant/components/DecisionPrompt";
import { Markdown } from "@egant/components/Markdown";
import { ToolActivityGroup } from "@egant/components/ToolCards";
import { fallbackName } from "@egant/lib/agents";
import { modeLabel, permissionSummary, timeLabel, truncate } from "@egant/lib/transcript";
import type { AgentRequest, Entry, PendingPermission } from "@egant/lib/types";
import type { MobileSession } from "../api";
import { localLink } from "../localLink";
import { usePrefs } from "../prefs";
import { useMobile } from "../store";
import type { LoadedTranscript, StartingChat } from "../store";
import { StatusLine, agentLabel } from "./bits";
import { Composer, ToolbarChip } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { IconButton, MenuIcon, SessionTitle, TopBar } from "./Header";
import { ModeSheet, ModelSheet, modelName } from "./Pickers";
import { RunPill } from "./RunPill";

/** How close to the bottom still counts as "at the bottom" — the desktop's
 * own rule, so a streaming reply keeps the view pinned the same way. */
const STICK_PX = 80;

/** One conversation: the title and model up top, the thread, and the
 * composer at the bottom with any permission prompt docked right above it,
 * where a thumb can reach it. */
export function Conversation({
  id,
  onMenu,
  needsYou,
}: {
  id: number;
  onMenu: () => void;
  needsYou: boolean;
}) {
  const session = useMobile((s) => s.sessions.find((row) => row.id === id));
  const transcript = useMobile((s) => s.transcripts[id]);
  const loadError = useMobile((s) => s.transcriptErrors[id]);
  const catalog = useMobile((s) => (session ? s.models[session.agent] : undefined));
  const loadModels = useMobile((s) => s.loadModels);
  const navigate = useMobile((s) => s.navigate);
  const openTranscript = useMobile((s) => s.openTranscript);
  const [modelSheet, setModelSheet] = useState(false);

  useEffect(() => {
    if (session?.kind !== "cli") void openTranscript(id);
  }, [id, session?.kind, openTranscript]);
  useEffect(() => {
    if (session?.kind === "chat") void loadModels(session.agent);
  }, [session?.agent, session?.kind, loadModels]);

  const left = (
    <IconButton label="Chats" onClick={onMenu} badge={needsYou}>
      <MenuIcon />
    </IconButton>
  );
  const right = (
    <IconButton label="New chat" onClick={() => navigate(null)}>
      <SquarePen size={21} strokeWidth={1.9} />
    </IconButton>
  );

  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <TopBar left={left} right={right} />
        <Centered>This chat isn't on your Mac any more.</Centered>
      </div>
    );
  }

  const model = modelName(
    session.agent,
    catalog,
    session.requestedModel,
    transcript?.model ?? session.model,
  );

  return (
    <div className="flex h-full flex-col">
      <TopBar
        left={left}
        right={right}
        center={
          <SessionTitle
            title={session.title}
            agent={session.agent}
            model={session.kind === "cli" ? agentLabel(session.agent, "cli") : model}
            variant={session.kind === "cli" ? null : session.variant}
            onClick={session.kind === "cli" ? undefined : () => setModelSheet(true)}
          />
        }
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
            className="press mt-4 rounded-full bg-[var(--raised-2)] px-5 py-2.5 text-[14px] text-[var(--ink)]"
          >
            Try again
          </button>
        </Centered>
      ) : (
        <Centered>
          <Loader2 size={20} strokeWidth={2} className="animate-spin text-[var(--faint)]" />
        </Centered>
      )}
      {session.kind === "chat" && (
        <ModelSheet open={modelSheet} onClose={() => setModelSheet(false)} session={session} />
      )}
    </div>
  );
}

/** A new chat between the send and the Mac's answer: the message already
 * on screen, and the agent starting up under it. */
export function StartingChat({ starting, onMenu }: { starting: StartingChat; onMenu: () => void }) {
  const catalog = useMobile((s) => s.models[starting.agent]);
  const project = useMobile((s) => s.projects.find((p) => p.id === starting.projectId));
  const [startedAt] = useState(() => Date.now());
  return (
    <div className="flex h-full flex-col">
      <TopBar
        left={
          <IconButton label="Chats" onClick={onMenu}>
            <MenuIcon />
          </IconButton>
        }
        center={
          <SessionTitle
            title={project ? project.name : "New chat"}
            agent={starting.agent}
            model={modelName(starting.agent, catalog, starting.model)}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
        <div className="mx-auto flex w-full max-w-[735px] flex-col gap-4">
          <UserBubble text={starting.text} />
          <StatusLine state="running" startedAt={startedAt} label={`Starting ${fallbackName(starting.agent)}`} />
        </div>
      </div>
      <div className="safe-bottom shrink-0 px-2.5 pt-1">
        <Composer value="" onChange={() => {}} onSubmit={() => {}} placeholder="Message" sending disabled />
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center text-[15px] text-[var(--muted)]">
      {children}
    </div>
  );
}

/** A terminal session has no transcript to show: its CLI draws itself, in a
 * terminal, on the Mac. */
function CliNotice({ session }: { session: MobileSession }) {
  return (
    <Centered>
      <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--raised)]">
        <TerminalSquare size={24} strokeWidth={1.75} className="text-[var(--muted)]" />
      </span>
      <div className="text-[17px] font-semibold text-[var(--ink)]">
        {agentLabel(session.agent, "chat")} runs in a terminal on your Mac
      </div>
      <div className="mt-2 max-w-[300px] leading-relaxed">
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
          className="h-full overflow-y-auto overscroll-contain px-4 pt-4 pb-6"
        >
          <div className="mx-auto flex w-full max-w-[735px] flex-col gap-5">
            {transcript.start > 0 && (
              <button
                type="button"
                disabled={transcript.loadingOlder}
                onClick={() => {
                  olderPending.current = true;
                  previousHeight.current = scrollRef.current?.scrollHeight ?? 0;
                  void loadOlder(session.id);
                }}
                className="press mx-auto flex items-center gap-1.5 rounded-full bg-[var(--raised)] px-4 py-2 text-[13px] text-[var(--muted)] disabled:opacity-60"
              >
                {transcript.loadingOlder && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
                Earlier messages
              </button>
            )}
            <Entries sessionId={session.id} entries={transcript.entries} busy={busy} />
            {transcript.entries.length === 0 && !busy && (
              <div className="py-16 text-center text-[15px] text-[var(--faint)]">
                Nothing here yet. Send the first message.
              </div>
            )}
            {busy && (
              <div className="-mt-2">
                <StatusLine state={transcript.state} startedAt={transcript.turnStartedAt} />
              </div>
            )}
            {/* The task is done — offer to run what it just changed, and to
              open it once it runs. Like the desktop, only between turns. */}
            {!busy && transcript.entries.length > 0 && (
              <div className="-mt-2 flex flex-col">
                <RunPill
                  session={session}
                  canRun={!(session.ended && transcript.sessionId == null)}
                  lastUserText={lastUserText(transcript.entries)}
                />
              </div>
            )}
          </div>
        </div>
        {!atBottom && (
          <button
            type="button"
            aria-label="Jump to the latest"
            onClick={jumpToBottom}
            className="press menu absolute bottom-3 left-1/2 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full text-[var(--ink)]"
          >
            <ArrowDown size={18} strokeWidth={2.2} />
          </button>
        )}
      </div>
      <div className="safe-bottom shrink-0 px-2.5 pt-1">
        <div className="mx-auto w-full max-w-[735px]">
          {pendingList.length > 0 && (
            <PermissionSheet
              items={pendingList}
              onAnswer={(requestId, decision) =>
                void answerPermission(session.id, requestId, decision)
              }
            />
          )}
          <ChatComposer session={session} transcript={transcript} />
        </div>
      </div>
    </>
  );
}

/** The newest thing the person said. */
function lastUserText(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "user") return entry.text;
  }
  return null;
}

/** The transcript's entries, drawn the way the desktop draws them: user
 * turns as bubbles, replies as Markdown, consecutive tool calls folded into
 * one activity block — plus the agent's thinking, collapsed (or left out,
 * if Settings says so). */
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
  const showThinking = usePrefs((s) => s.showThinking);
  const nodes: ReactNode[] = [];
  let i = 0;
  let previous: Entry | undefined;
  // The last finished reply gets its copy row; earlier ones keep it quieter.
  let lastReply = -1;
  entries.forEach((entry, index) => {
    if (entry.kind === "assistant" && !entry.streaming && entry.text.trim() !== "") lastReply = index;
  });
  while (i < entries.length) {
    const entry = entries[i]!;
    if (entry.kind === "tool") {
      let j = i + 1;
      while (j < entries.length && entries[j]!.kind === "tool") j++;
      nodes.push(
        <div key={`tools-${i}`} className="text-[14px]">
          <ToolActivityGroup entries={entries.slice(i, j) as Extract<Entry, { kind: "tool" }>[]} />
        </div>,
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
      (entry.kind === "thinking" && (!showThinking || (!entry.streaming && entry.text.trim() === "")));
    if (!hidden) {
      // Thinking is only live at the tail of a running turn: a transcript
      // saved by an older build can hold thinking still marked as streaming.
      const settled =
        entry.kind === "thinking" && entry.streaming && (!busy || i < entries.length - 1)
          ? { ...entry, streaming: false }
          : entry;
      nodes.push(<EntryView key={i} entry={settled} sessionId={sessionId} last={i === lastReply} />);
    }
    if (entry.kind !== "thinking") previous = entry;
    i++;
  }
  return <>{nodes}</>;
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex w-full justify-end pl-10">
      <div className="max-w-full rounded-[22px] rounded-br-[8px] bg-[var(--bubble)] px-4 py-2.5 text-[16px] leading-6 break-words whitespace-pre-wrap text-[var(--ink)]">
        {text}
      </div>
    </div>
  );
}

function EntryView({ entry, sessionId, last }: { entry: Entry; sessionId: number; last: boolean }) {
  const openPreview = useMobile((s) => s.openPreview);
  switch (entry.kind) {
    case "user":
      return <UserBubble text={entry.text} />;
    case "assistant":
      return (
        <div
          className="phone-md flex w-full min-w-0 flex-col gap-2"
          onClick={(event) => {
            // "It's running at http://localhost:5173" — on a phone, that link
            // opens the phone's own localhost, which is nothing. Ask the Mac
            // for the site instead, and show it in the app.
            const anchor = (event.target as HTMLElement).closest("a");
            const target = localLink(anchor?.getAttribute("href"));
            if (!target) return;
            event.preventDefault();
            void openPreview(sessionId, target);
          }}
        >
          <Markdown text={entry.streaming ? `${entry.text}▌` : entry.text} />
          {!entry.streaming && (
            <div
              className={`-ml-1.5 flex items-center gap-1 text-[12px] text-[var(--faint)] ${last ? "" : "opacity-70"}`}
            >
              <CopyButton text={entry.text} />
              {entry.at !== undefined && <span className="pl-1">{timeLabel(entry.at)}</span>}
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
          className={`w-full rounded-2xl px-3.5 py-3 text-[13.5px] leading-5 break-words whitespace-pre-wrap ${
            entry.isError
              ? "bg-[rgba(224,112,112,0.12)] text-[var(--danger)]"
              : "bg-[var(--raised)] text-[var(--muted)]"
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
    <div className="flex w-full min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start text-[14px] text-[var(--muted)]"
      >
        <Brain size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        <span className={entry.streaming ? "shimmer" : ""}>{label}</span>
        {text &&
          (open ? (
            <ChevronDown size={13} strokeWidth={2} className="text-[var(--faint)]" />
          ) : (
            <ChevronRight size={13} strokeWidth={2} className="text-[var(--faint)]" />
          ))}
      </button>
      {text && (open || entry.streaming) && (
        <div className="border-l-2 border-[var(--hairline)] pl-3 text-[13.5px] leading-[21px] break-words whitespace-pre-wrap text-[var(--faint)]">
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
      className="press flex h-8 w-8 items-center justify-center rounded-full active:bg-[var(--hover)]"
    >
      {copied ? <Check size={15} strokeWidth={2.2} /> : <Copy size={15} strokeWidth={2} />}
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
    <div className="fade-up mb-2 flex max-h-[46vh] flex-col gap-2 overflow-y-auto rounded-[24px] border border-amber-400/25 bg-[var(--raised)] p-3 shadow-[0_12px_40px_rgba(0,0,0,0.3)]">
      <div className="flex items-center gap-2 px-1">
        <Shield size={16} strokeWidth={2.2} className="shrink-0 text-amber-500 dark:text-amber-300" />
        <div className="text-[15px] font-semibold text-[var(--ink)]">
          {items.length === 1 ? "Allow this?" : `${items.length} actions need you`}
        </div>
        <div className="ml-auto text-[12px] text-[var(--faint)]">Nothing runs until you answer</div>
      </div>
      {items.map((pending) => (
        <div key={pending.requestId} className="flex flex-col gap-2.5 rounded-[18px] bg-[var(--raised-2)]/60 p-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="self-start rounded-md bg-[var(--stage)] px-2 py-0.5 font-mono text-[12px] text-[var(--ink)]">
              {pending.toolName}
            </span>
            <span className="min-w-0 font-mono text-[12.5px] leading-5 break-all text-[var(--muted)]">
              {truncate(permissionSummary(pending.input), 400)}
            </span>
          </div>
          {confirming === pending.requestId ? (
            <div className="flex flex-col gap-2">
              <div className="text-[13px] leading-relaxed text-[var(--muted)]">
                Allow always also switches this chat to Bypass permissions — it won't ask again for
                anything.
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
                Allow
              </SheetButton>
              <SheetButton onClick={() => setConfirming(pending.requestId)}>Always</SheetButton>
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
      className={`press h-10 flex-1 rounded-full px-3 text-[14px] font-medium ${
        primary
          ? "bg-[var(--ink)] text-[var(--stage)]"
          : quiet
            ? "bg-transparent text-[var(--danger)]"
            : "bg-[var(--stage)] text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

/** The composer of an open chat, with its permission mode riding along and
 * where it runs beside it. */
function ChatComposer({ session, transcript }: { session: MobileSession; transcript: LoadedTranscript }) {
  const send = useMobile((s) => s.send);
  const interrupt = useMobile((s) => s.interrupt);
  const setSessionMode = useMobile((s) => s.setSessionMode);
  const [text, setText] = useState("");
  const [modeSheet, setModeSheet] = useState(false);

  const busy = transcript.state === "running" || transcript.state === "awaiting_permission";
  // The desktop composer's rule: an ended session the agent recorded a
  // conversation id for is resumed by the next message; only one that never
  // got that far is really over.
  const ended = session.ended && transcript.sessionId == null;
  const mode = session.permissionMode;
  const place = session.worktree?.name ?? session.branch;

  return (
    <>
      <Composer
        value={text}
        onChange={setText}
        onSubmit={() => {
          void send(session.id, text);
          setText("");
        }}
        placeholder={ended ? "This chat has ended" : "Message"}
        disabled={ended}
        busy={busy}
        onStop={() => void interrupt(session.id)}
        toolbar={
          <>
            <ToolbarChip
              icon={
                mode === "bypassPermissions" ? (
                  <ShieldOff size={14} strokeWidth={2} />
                ) : (
                  <Shield size={14} strokeWidth={2} />
                )
              }
              label={modeLabel(mode)}
              tone={mode === "bypassPermissions" ? "warn" : undefined}
              onClick={() => setModeSheet(true)}
            />
            {place && (
              <span className="flex h-8 min-w-0 shrink items-center gap-1.5 px-1.5 text-[12.5px] text-[var(--faint)]">
                {session.worktree ? (
                  <FolderGit2 size={13} strokeWidth={2} className="shrink-0" />
                ) : (
                  <GitBranch size={13} strokeWidth={2} className="shrink-0" />
                )}
                <span className="min-w-0 truncate">{place}</span>
              </span>
            )}
          </>
        }
      />
      <ModeSheet
        open={modeSheet}
        onClose={() => setModeSheet(false)}
        agent={session.agent}
        mode={mode}
        onPick={(next) => void setSessionMode(session.id, next)}
      />
    </>
  );
}
