import {
  ArrowUp,
  Clock,
  Folder,
  FoldVertical,
  FolderTree,
  GitBranch,
  Loader2,
  Paperclip,
  Pencil,
  Square,
  TerminalSquare,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, pickAttachments } from "../lib/api";
import { log } from "../lib/logger";
import { modShortcut } from "../lib/platform";
import { commandItems, findTrigger, mention } from "../lib/composerMenu";
import { fuzzyFilter } from "../lib/fuzzy";
import { contextFraction } from "../lib/transcript";
import { selectNextAgent, useEgant, usesChatUi } from "../store";
import { AgentPicker, agentName } from "./AgentPicker";
import { ComposerMenu, type MenuItem } from "./ComposerMenu";
import { ModeInfo } from "./ModeInfo";
import { SessionModelPicker } from "./SessionModelPicker";
import { UsageMeter } from "./UsageMeter";

/** How full the context window gets before the footer offers to compact it —
 * about where Claude's own CLI starts warning that it will. */
const COMPACT_OFFER_AT = 0.8;

/** How many rows a `/` or `@` menu offers at most. */
const MENU_LIMIT = 50;

/** How long a folder's file list serves the `@` menu before it is fetched
 * again — long enough for one message, short enough to see a file the agent
 * just wrote. */
const FILES_FRESH_MS = 15_000;

/** A clipboard image between paste and send: shown as a thumbnail chip while
 * it's written to a temp file, then carried as an `@path` mention once that
 * resolves. `error` means the write failed — the chip stays so the user can
 * see it and remove it, but it never joins the message. */
type PastedImage = {
  id: string;
  dataUrl: string;
  path: string | null;
  error: boolean;
};

/** The one control that drives the window, in the two shapes it takes.
 *
 * `hero` is the launch screen's: a tall box with its chips on a row beneath.
 * The default is the conversation's, laid out the way Claude Code Desktop's
 * is: a single-line pill — attach, text, the model badge, send — over a quiet
 * row saying where the session runs and how full its context is. Same glass,
 * same keys, because it is the same control in both places. */
export function Composer({
  sessionId,
  hero,
  autoFocus,
}: {
  /** Null on the launch screen before a folder is open: the send path creates
   * the session it needs. */
  sessionId: number | null;
  hero?: boolean;
  autoFocus?: boolean;
}) {
  const transcript = useEgant((s) => (sessionId == null ? undefined : s.transcripts[sessionId]));
  const session = useEgant((s) => s.snapshot?.sessions.find((x) => x.id === sessionId));
  const send = useEgant((s) => s.send);
  const sendOnLaunch = useEgant((s) => s.sendOnLaunch);
  const interrupt = useEgant((s) => s.interrupt);
  const focusComposerToken = useEgant((s) => s.focusComposerToken);
  const openSettings = useEgant((s) => s.openSettings);
  const snapshot = useEgant((s) => s.snapshot);
  const composerAgentPick = useEgant((s) => s.composerAgent);
  const claudeUsage = useEgant((s) => s.claudeUsage);
  const fetchClaudeUsage = useEgant((s) => s.fetchClaudeUsage);
  const catalog = useEgant((s) => s.catalog);
  const chatUiAgents = useEgant((s) => s.chatUiAgents);
  const askCliLaunch = useEgant((s) => s.askCliLaunch);
  const queue = useEgant((s) => (sessionId == null ? undefined : s.queues[sessionId]));
  const unqueueMessage = useEgant((s) => s.unqueueMessage);
  const sendQueuedNow = useEgant((s) => s.sendQueuedNow);

  const [text, setText] = useState("");
  // Where the caret sits, for the `/` and `@` menus: what it is in decides
  // which one (if either) is open.
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  /** The trigger Esc closed the menu on, so it stays closed until the caret
   * moves to another one. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [files, setFiles] = useState<{ root: string; list: string[]; at: number } | null>(null);
  const createSession = useEgant((s) => s.createSession);
  const requestPicker = useEgant((s) => s.requestPicker);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Measured on the composer's own box, not the window: a wide window with
  // the workspace panel dragged out squeezes it exactly the way a narrow
  // window would. Two steps down from the full row:
  // - `compact`: the badge drops its effort label and the footer its
  //   "Local checkout" words — the icons (and their tooltips) still say it.
  // - `narrow`: the text box and the toolbar stop sharing a row (Zeron's
  //   answer to the squeeze), so the text gets the full width above it
  //   instead of either one being crushed.
  const [width, setWidth] = useState(Infinity);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || hero) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hero]);
  const compact = width < 560;
  const narrow = width < 420;

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  // The lightbox is the only thing Esc needs to close here — the textarea
  // itself has no escape behavior to conflict with.
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewImage]);

  useEffect(() => {
    if (focusComposerToken > 0) areaRef.current?.focus();
  }, [focusComposerToken]);

  // Grows with the message rather than scrolling a one-line box.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 240)}px`;
  }, [text]);

  const busy = transcript?.state === "running" || transcript?.state === "awaiting_permission";
  // A session the agent exited from — or one just restored from disk on
  // launch — still has a live conversation behind it as long as the CLI
  // recorded a session id: sending into it asks the backend to resume that
  // id (`claude --resume`, `codex exec resume <thread>`, `opencode run -s`)
  // rather than starting over. Only a session that never got that far (it
  // failed before its first reply) has truly nothing left to continue.
  const resumable = (session?.ended ?? false) && transcript?.sessionId != null;
  const ended = (session?.ended ?? false) && !resumable;
  const hasText = text.trim().length > 0;
  // Claude's own `/compact`, offered once the window is mostly full: it
  // summarizes the conversation so far and carries on from the summary. Only
  // for Claude — the one agent whose compaction egant can see happen — and
  // only between turns; the divider it leaves is what shows it worked.
  const canCompact =
    session?.agent === "claude" &&
    transcript != null &&
    !busy &&
    !ended &&
    transcript.usage.contextTokens > 0 &&
    contextFraction(transcript.usage) >= COMPACT_OFFER_AT;
  // The `/` and `@` menus: only in a conversation, where there is a session
  // to list commands for and a folder to list files in.
  const trigger = sessionId != null && !hero ? findTrigger(text, caret) : null;
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const menuOpen = trigger != null && triggerKey !== dismissed;
  const cwd = session?.cwd ?? null;
  const commands = useMemo(
    () => (session ? commandItems(session.agent, transcript?.commands) : []),
    [session?.agent, transcript?.commands],
  );
  const menuItems = useMemo((): MenuItem[] => {
    if (!menuOpen || !trigger) return [];
    if (trigger.kind === "command") {
      return fuzzyFilter(commands, trigger.query, (c) => c.name, MENU_LIMIT).map((command) => ({
        kind: "command",
        command,
      }));
    }
    if (!files || files.root !== cwd) return [];
    return fuzzyFilter(files.list, trigger.query, (path) => path, MENU_LIMIT).map((path) => ({
      kind: "file",
      path,
    }));
  }, [menuOpen, trigger?.kind, trigger?.query, commands, files, cwd]);
  const menuStatus =
    trigger?.kind === "mention" && (!files || files.root !== cwd)
      ? "Listing files…"
      : trigger?.kind === "mention"
        ? "No file matches"
        : "No command matches";

  // The `@` menu's files, fetched as it opens — and again once they are old
  // enough to be missing what the agent just wrote.
  const mentionOpen = menuOpen && trigger?.kind === "mention";
  useEffect(() => {
    if (!mentionOpen || cwd == null) return;
    if (files && files.root === cwd && Date.now() - files.at < FILES_FRESH_MS) return;
    let live = true;
    api
      .listFiles(cwd)
      .then((list) => {
        if (live) setFiles({ root: cwd, list, at: Date.now() });
      })
      .catch((error: unknown) => log.warn("composer", `couldn't list files in ${cwd}: ${String(error)}`));
    return () => {
      live = false;
    };
  }, [mentionOpen, cwd, files]);

  // A new query starts at the top of the list.
  useEffect(() => setMenuIndex(0), [trigger?.kind, trigger?.query]);

  /** Puts `replacement` where the trigger's word is, and the caret after it. */
  const replaceTrigger = (replacement: string) => {
    if (!trigger) return;
    const rest = text.slice(trigger.end);
    const next = text.slice(0, trigger.start) + replacement + (replacement === "" ? rest.trimStart() : rest);
    const at = trigger.start + replacement.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      areaRef.current?.focus();
      areaRef.current?.setSelectionRange(at, at);
    });
  };

  const pick = (item: MenuItem) => {
    if (item.kind === "file") {
      const rest = text.slice(trigger?.end ?? 0);
      replaceTrigger(rest.startsWith(" ") ? mention(item.path) : `${mention(item.path)} `);
      return;
    }
    const { command } = item;
    switch (command.run) {
      case "insert": {
        const rest = text.slice(trigger?.end ?? 0);
        replaceTrigger(rest.startsWith(" ") ? `/${command.name}` : `/${command.name} `);
        return;
      }
      case "model":
      case "mode":
        replaceTrigger("");
        if (sessionId != null) requestPicker(sessionId, command.run);
        return;
      case "clear":
        replaceTrigger("");
        void createSession();
        return;
    }
  };

  // The agent is fixed when the session starts; the model and effort under
  // it are what the badge switches.
  const agents = useEgant((s) => s.agents);
  const agent = session?.agent ?? null;
  const mode = session?.permissionMode ?? "auto";

  // Before a session exists, the composer already knows which agent the next
  // message would start — so a sign-in problem can be flagged before the
  // user hits send and gets a failed session for their trouble, instead of
  // silently promising a model this device isn't actually logged into.
  const nextAgentId = sessionId == null ? selectNextAgent(snapshot, composerAgentPick) : null;
  const nextAgentStatus = nextAgentId ? agents.find((a) => a.id === nextAgentId) : undefined;
  // The agent the next session would start *as a CLI* rather than as chat —
  // either one egant has no harness for, or one whose chat UI the picker's
  // toggle has been turned off for. There is no message to compose for it:
  // its own prompt is the composer, so this box hands over to the terminal
  // instead of pretending it will send something.
  const cliAgent =
    nextAgentId && !usesChatUi(catalog, chatUiAgents, nextAgentId) ? nextAgentId : null;
  const connectionNotice =
    nextAgentStatus == null || cliAgent != null
      ? // A CLI-only agent has no login state egant tracks (`pi` is never
        // "connected"), so the sign-in warning would be permanent and wrong.
        // Whether the binary is there is the launch dialog's business.
        null
      : !nextAgentStatus.installed
        ? `${nextAgentStatus.name} isn't installed on this device.`
        : !nextAgentStatus.connected
          ? `${nextAgentStatus.name} isn't connected on this device — sign in before sending.`
          : null;
  const cliAgentName = cliAgent
    ? (catalog.find((c) => c.id === cliAgent)?.name ?? agentName(agents, cliAgent))
    : "";

  // Only Claude has a usage endpoint to poll. Fetches once whenever the
  // composer starts pointing at Claude (a fresh launch screen, a switch in
  // the picker, or an existing Claude session mounting), then every five
  // minutes while it keeps pointing there — same cadence community
  // status-line tools use to avoid hammering the endpoint.
  const claudeActive = (sessionId == null ? nextAgentId : agent) === "claude";
  useEffect(() => {
    if (!claudeActive) return;
    void fetchClaudeUsage();
    const timer = setInterval(() => void fetchClaudeUsage(), 5 * 60_000);
    return () => clearInterval(timer);
  }, [claudeActive, fetchClaudeUsage]);

  // Pasted images ride along as real attachments — each backend attaches
  // them the way it actually supports (a vision block for Claude, `-i` for
  // Codex, `-f` for opencode) — but only once each has actually landed on
  // disk; one still saving blocks the send rather than going out without it.
  const imagesSaving = pastedImages.some((img) => img.path == null && !img.error);
  const readyImages = pastedImages.filter((img) => img.path != null);
  const hasContent = hasText || pastedImages.length > 0;

  const submit = () => {
    // In CLI mode the button is the way into the terminal, not a send.
    if (cliAgent) {
      askCliLaunch(cliAgent);
      return;
    }
    if (!hasContent || ended || imagesSaving) return;
    const paths = readyImages.map((img) => img.path as string);
    if (hero || sessionId == null) void sendOnLaunch(text, paths);
    else void send(sessionId, text, paths);
    setText("");
    setPastedImages([]);
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const attach = async () => {
    const paths = await pickAttachments().catch(() => [] as string[]);
    if (paths.length === 0) return;
    const mention = paths.map((p) => `@${p}`).join(" ");
    setText((prev) => (prev.trim() === "" ? `${mention} ` : `${prev.trimEnd()} ${mention} `));
    areaRef.current?.focus();
  };

  // A pasted image becomes a thumbnail chip immediately (from the clipboard's
  // own bytes) and a real `@path` mention once the write to disk resolves —
  // the CLIs only understand file paths, never inline clipboard data.
  const addPastedImage = (file: File) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : null;
      if (!dataUrl) return;
      setPastedImages((prev) => [...prev, { id, dataUrl, path: null, error: false }]);
      api
        .savePastedImage(dataUrl)
        .then((path) => {
          setPastedImages((prev) => prev.map((img) => (img.id === id ? { ...img, path } : img)));
        })
        .catch((error: unknown) => {
          log.error("composer", `couldn't save pasted image: ${String(error)}`, error);
          setPastedImages((prev) =>
            prev.map((img) => (img.id === id ? { ...img, error: true } : img)),
          );
        });
    };
    reader.readAsDataURL(file);
  };

  const removePastedImage = (id: string) => {
    setPastedImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const images = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (images.length === 0) return;
    // A clipboard image often carries a text/html fallback alongside it (a
    // screenshot copied from a browser, say) — once there's an image, that's
    // the paste; the text side would only dump alt text or markup into the box.
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (file) addPastedImage(file);
    }
  };

  const area = (
    <textarea
      ref={areaRef}
      value={text}
      rows={hero ? 3 : 1}
      disabled={ended || cliAgent != null}
      onChange={(e) => {
        setText(e.target.value);
        setCaret(e.target.selectionStart ?? e.target.value.length);
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
      onPaste={handlePaste}
      onKeyDown={(e) => {
        // An open menu has the keys first: arrows walk it, Enter or Tab take
        // the highlighted row, Esc closes it and leaves the text alone.
        if (menuOpen && !e.nativeEvent.isComposing) {
          if (e.key === "Escape") {
            e.preventDefault();
            setDismissed(triggerKey);
            return;
          }
          if (menuItems.length > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setMenuIndex((i) => (i + step + menuItems.length) % menuItems.length);
              return;
            }
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
              e.preventDefault();
              pick(menuItems[Math.min(menuIndex, menuItems.length - 1)]!);
              return;
            }
          }
        }
        // Plain Enter sends without inserting a newline; shift-Enter still
        // breaks the line.
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        }
      }}
      placeholder={
        cliAgent
          ? `${cliAgentName} runs in its own terminal`
          : busy
            ? "Queue a message…"
            : "Do anything…"
      }
      className="block max-h-[240px] w-full resize-none bg-transparent text-[15px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
    />
  );

  // A pasted image's chip, the way Claude Code Desktop shows it: a small
  // thumbnail above the text rather than a `@path` string inline — the
  // mention only appears in the message that actually goes out on send.
  const imageRow =
    pastedImages.length > 0 ? (
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {pastedImages.map((img) => (
          <div key={img.id} className="group relative h-11 w-11 shrink-0">
            <button
              type="button"
              title={img.error ? "Couldn't save this image" : "Click to view"}
              onClick={() => {
                if (!img.error) setPreviewImage(img.dataUrl);
              }}
              className={`h-11 w-11 cursor-pointer overflow-hidden rounded-lg border bg-[var(--card)] ${
                img.error ? "border-[var(--danger)]/50" : "border-[var(--border)]"
              }`}
            >
              <img
                src={img.dataUrl}
                alt="Pasted"
                className={`h-full w-full object-cover ${img.error ? "opacity-40" : ""}`}
              />
              {img.path == null && !img.error && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/35">
                  <Loader2 size={14} strokeWidth={2.5} className="animate-spin text-white" />
                </span>
              )}
            </button>
            <button
              type="button"
              title="Remove"
              onClick={() => removePastedImage(img.id)}
              className="absolute -right-1.5 -top-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] bg-[var(--stage)] text-[var(--muted)] opacity-0 hover:text-[var(--ink)] group-hover:opacity-100"
            >
              <X size={10} strokeWidth={2.5} />
            </button>
          </div>
        ))}
      </div>
    ) : null;

  // Messages sent while the agent works wait here, oldest first, until the
  // turn ends — then the backend sends the next one. Each can go out now
  // (stopping the turn), come back into the box to be edited, or be dropped.
  // Editing is left off one that carries images, which the box can't hold.
  const editQueued = async (queuedId: number) => {
    if (sessionId == null) return;
    const queuedText = await unqueueMessage(sessionId, queuedId);
    if (queuedText == null) return;
    setText((prev) => (prev.trim() ? `${queuedText}\n${prev}` : queuedText));
    requestAnimationFrame(() => areaRef.current?.focus());
  };
  const queueRow =
    sessionId != null && queue && queue.length > 0 ? (
      <div className="mb-1.5 flex flex-col gap-1 px-1">
        {queue.map((queued) => (
          <div
            key={queued.id}
            className="row-in flex min-w-0 items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] py-1.5 pr-1.5 pl-3 text-[12.5px]"
          >
            <Clock size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
            <span className="min-w-0 flex-1 truncate text-[var(--muted)]" title={queued.text}>
              {queued.text}
            </span>
            {queued.imageCount > 0 && (
              <span className="shrink-0 text-[11px] text-[var(--faint)]">
                +{queued.imageCount} image{queued.imageCount === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              title={busy ? "Send now — stops the current turn first" : "Send now"}
              onClick={() => void sendQueuedNow(sessionId, queued.id)}
              className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              Send now
            </button>
            {queued.imageCount === 0 && (
              <button
                type="button"
                title="Edit — back into the box"
                onClick={() => void editQueued(queued.id)}
                className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              >
                <Pencil size={12} strokeWidth={2} />
              </button>
            )}
            <button
              type="button"
              title="Remove from the queue"
              onClick={() => void unqueueMessage(sessionId, queued.id)}
              className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    ) : null;

  // Full-size, on demand — the chip only hints at what was pasted. Portaled
  // to the body: the composer's own `backdrop-filter` would otherwise clip a
  // `fixed` overlay to its own bounds instead of the full viewport.
  const lightbox = previewImage
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-10 backdrop-blur-sm"
          onMouseDown={() => setPreviewImage(null)}
        >
          <img
            src={previewImage}
            alt="Pasted image preview"
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            title="Close"
            onClick={() => setPreviewImage(null)}
            className="absolute right-6 top-6 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60"
          >
            <X size={16} strokeWidth={2.5} />
          </button>
        </div>,
        document.body,
      )
    : null;

  const attachButton = (
    <button
      type="button"
      title="Attach a file or folder"
      onClick={() => void attach()}
      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      <Paperclip size={17} strokeWidth={2} />
    </button>
  );

  const sendButton = busy ? (
    <button
      type="button"
      title={`Stop the turn · ${modShortcut("⎋")}`}
      onClick={() => {
        if (sessionId != null) void interrupt(sessionId);
      }}
      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f2f2f5] text-[#0c0c0e] hover:opacity-85"
    >
      <Square size={12} strokeWidth={2} fill="currentColor" />
    </button>
  ) : (
    // Always the same light disc, the way the reference draws it even over
    // an empty box — `submit` is what refuses an empty or ended send. In CLI
    // mode it opens the terminal instead, which needs no message.
    <button
      type="button"
      title={cliAgent ? `Open the ${cliAgentName} CLI` : "Send · ⏎"}
      aria-disabled={!cliAgent && (!hasContent || ended)}
      onClick={submit}
      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f2f2f5] text-[#0c0c0e] hover:opacity-85"
    >
      {cliAgent ? (
        <TerminalSquare size={15} strokeWidth={2.5} />
      ) : (
        <ArrowUp size={16} strokeWidth={2.5} />
      )}
    </button>
  );

  if (hero || sessionId == null) {
    return (
      <div ref={wrapRef} className="composer w-full rounded-2xl px-5 py-4">
        {connectionNotice && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-200">
            <span className="flex min-w-0 items-center gap-1.5">
              <TriangleAlert size={13} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{connectionNotice}</span>
            </span>
            <button
              type="button"
              onClick={() => openSettings("accounts")}
              className="shrink-0 cursor-pointer font-medium underline underline-offset-2 hover:text-amber-100"
            >
              Connect
            </button>
          </div>
        )}
        {imageRow}
        {area}
        {/* Picker left, actions right — the launch picker chooses what the
          next session starts with (agent, model, effort). */}
        <div className="mt-3 flex min-w-0 items-center justify-between gap-2.5">
          <div className="min-w-0">
            <AgentPicker />
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {attachButton}
            {sendButton}
          </div>
        </div>
        {lightbox}
      </div>
    );
  }

  // Where this session runs — fixed once it starts, so these are labels, not
  // menus. A worktree session is named for what it is; the branch is the
  // worktree's own, or whatever the project folder was on.
  const worktree = session?.worktree ?? null;
  const branch = worktree?.branch ?? session?.branch ?? null;

  return (
    <div ref={wrapRef} className="w-full min-w-0">
      {queueRow}
      {/* One DOM for both widths — only classes change — so the text box is
        never remounted (and never loses focus or its caret) as the column is
        dragged across the breakpoint. */}
      <div className="relative">
        {/* A `/` that matches no command is most likely a path being typed:
          say nothing rather than "no match" under every keystroke. */}
        {menuOpen && !(trigger?.kind === "command" && menuItems.length === 0) && (
          <ComposerMenu
            items={menuItems}
            index={Math.min(menuIndex, Math.max(0, menuItems.length - 1))}
            status={menuStatus}
            onHover={setMenuIndex}
            onPick={pick}
          />
        )}
        <div
          className={`composer flex w-full flex-wrap items-end gap-x-2 rounded-[26px] py-2 pr-2 pl-2 ${
            narrow ? "gap-y-1" : ""
          }`}
        >
          {imageRow && <div className="order-first basis-full px-2 pt-1">{imageRow}</div>}
          <div className={narrow ? "order-2" : "order-1"}>{attachButton}</div>
          <div
            className={`order-1 min-w-0 py-1 ${narrow ? "w-full basis-full px-2.5" : "flex-1 pr-1"}`}
          >
            {area}
          </div>
          <div
            className={`order-2 flex min-w-0 items-center justify-end gap-1.5 ${
              narrow ? "flex-1" : "max-w-[46%] shrink-0"
            }`}
          >
            {agent != null && (
              <SessionModelPicker sessionId={sessionId} agent={agent} compact={compact && !narrow} />
            )}
            {sendButton}
          </div>
        </div>
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-2.5 text-[13px] text-[var(--muted)] select-none">
        <div className="flex min-w-0 items-center gap-4">
          <span
            title={
              worktree
                ? `Running in its own worktree at ${worktree.path} (cut from ${worktree.base})`
                : `Running in the project folder — ${session?.cwd ?? ""}`
            }
            className="flex min-w-0 shrink-0 items-center gap-1.5"
          >
            {worktree ? (
              <FolderTree size={15} strokeWidth={1.8} className="shrink-0" />
            ) : (
              <Folder size={15} strokeWidth={1.8} className="shrink-0" />
            )}
            {!compact && (
              <span className="whitespace-nowrap">{worktree ? "Worktree" : "Local checkout"}</span>
            )}
          </span>
          {branch && (
            <span title={`On ${branch}`} className="flex min-w-0 items-center gap-1.5">
              <GitBranch size={14} strokeWidth={1.8} className="shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canCompact && (
            <button
              type="button"
              title="Compact the conversation: Claude summarizes it so far and carries on from the summary, freeing up context. The transcript here stays as it is."
              onClick={() => void send(sessionId, "/compact")}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              <FoldVertical size={14} strokeWidth={1.8} className="shrink-0" />
              {!compact && <span className="whitespace-nowrap">Compact</span>}
            </button>
          )}
          {agent != null && <ModeInfo sessionId={sessionId} agent={agent} mode={mode} />}
          {transcript && (
            <UsageMeter
              usage={transcript.usage}
              costUsd={transcript.totalCostUsd}
              claudeUsage={claudeActive ? claudeUsage : null}
              showPercent
            />
          )}
        </div>
      </div>
      {lightbox}
    </div>
  );
}
