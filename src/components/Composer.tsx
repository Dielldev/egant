import { ArrowUp, Loader2, Paperclip, Square, TerminalSquare, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, pickAttachments } from "../lib/api";
import { log } from "../lib/logger";
import { formatContext } from "../lib/types";
import { prettyClaudeModelId } from "../lib/transcript";
import { selectNextAgent, useEgant, usesChatUi } from "../store";
import { AGENT_ACCENT, AGENT_PROVIDER, AgentPicker, agentName } from "./AgentPicker";
import { ModeInfo } from "./ModeInfo";
import { ProviderGlyph } from "./ProviderLogo";
import { UsageMeter } from "./UsageMeter";

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
 * The default is the conversation's: a single-line pill with the same chips
 * inline on the right. Same glass, same chips, same keys — only the height
 * differs, because it is the same control in both places. */
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

  const [text, setText] = useState("");
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Below this the picker/attach/send block and the text box are fighting
  // over the same row — Zeron's answer is to stop sharing the row instead of
  // letting either one lose, so the toolbar drops beneath the text once
  // there isn't room for both. Measured on the composer's own box, not the
  // window: a wide window with the workspace panel dragged out squeezes this
  // exactly the way a narrow window would.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || hero) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 480);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hero]);

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
  // The agent is fixed when the session starts; only Claude reports a live
  // model and accepts mid-session permission changes.
  const agents = useEgant((s) => s.agents);
  const models = useEgant((s) => s.models);
  const agent = session?.agent ?? null;
  const agentDisplay = agentName(agents, agent);
  const requestedModel = transcript?.model ?? session?.modelOverride ?? null;
  // A live Claude session reports its fully-resolved model id (date stamp and
  // all — "claude-haiku-4-5-20251001"), which never matches the curated
  // catalog's short alias ("haiku"); `prettyClaudeModelId` reconstructs the
  // same display shape the catalog uses instead of leaking the raw id.
  const displayModel =
    (requestedModel && models.find((m) => m.id === requestedModel)?.name) ||
    (requestedModel && agent === "claude" ? prettyClaudeModelId(requestedModel) : requestedModel) ||
    agentDisplay;
  const sessionContext =
    session?.context != null && session.context > 0
      ? formatContext(session.context)
      : "";
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
      onChange={(e) => setText(e.target.value)}
      onPaste={handlePaste}
      onKeyDown={(e) => {
        // Plain Enter sends without inserting a newline; shift-Enter still
        // breaks the line.
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        }
      }}
      placeholder={
        cliAgent ? `${cliAgentName} runs in its own terminal` : "Do anything…"
      }
      className="max-h-[240px] w-full resize-none bg-transparent text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
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

  const picker =
    sessionId == null ? (
      // Nothing to meter before a session exists — the launch screen offers
      // only the agent/model pick, same as Claude Code Desktop's own.
      <AgentPicker />
    ) : (
      // The agent is fixed once a session starts, so this is a plain label —
      // the mode pill and the usage meter are the only interactive controls
      // here now.
      <div className="flex min-w-0 max-w-[340px] items-center gap-1">
        <span
          title={`${agentDisplay} session`}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
        >
          <ProviderGlyph
            provider={AGENT_PROVIDER[agent ?? ""] ?? agent ?? "claude"}
            size={14}
            color={agent ? AGENT_ACCENT[agent] : undefined}
          />
          <span className="truncate font-medium text-[var(--ink)]">{displayModel}</span>
          {sessionContext !== "" && (
            <span className="shrink-0 text-[var(--muted)]">· {sessionContext}</span>
          )}
        </span>
        {agent != null && <ModeInfo sessionId={sessionId} agent={agent} mode={mode} />}
        {transcript && (
          <UsageMeter
            usage={transcript.usage}
            costUsd={transcript.totalCostUsd}
            claudeUsage={claudeActive ? claudeUsage : null}
          />
        )}
      </div>
    );

  const actions = (
    <>
      <button
        type="button"
        title="Attach a file or folder"
        onClick={() => void attach()}
        className="shrink-0 cursor-pointer rounded-full p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <Paperclip size={15} strokeWidth={2} />
      </button>
      {busy ? (
        <button
          type="button"
          title="Stop the turn · ⌘⎋"
          onClick={() => {
            if (sessionId != null) void interrupt(sessionId);
          }}
          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#f2f2f5] text-[#0c0c0e] hover:opacity-85"
        >
          <Square size={12} strokeWidth={2} fill="currentColor" />
        </button>
      ) : (
        // Always there, visibly inert until the message is worth sending —
        // except in CLI mode, where it is always live, because opening the
        // terminal needs no message.
        <button
          type="button"
          title={cliAgent ? `Open the ${cliAgentName} CLI` : "Send · ⏎"}
          onClick={submit}
          className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full hover:opacity-85 ${
            cliAgent || (hasContent && !ended)
              ? "bg-[#f2f2f5] text-[#0c0c0e]"
              : "bg-[var(--bubble)] text-[var(--faint)]"
          }`}
        >
          {cliAgent ? (
            <TerminalSquare size={15} strokeWidth={2.5} />
          ) : (
            <ArrowUp size={16} strokeWidth={2.5} />
          )}
        </button>
      )}
    </>
  );

  // Hero always stacks; a threaded composer stacks too once its own box gets
  // too narrow for the toolbar to share a row with the text — see `narrow`.
  const stacked = hero || narrow;

  if (stacked) {
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
        {/* Picker left, actions right — matches the reference bar where the
          model (`Fable 5.1 High · 200K`) sits opposite the paperclip/send. */}
        <div className="mt-3 flex min-w-0 items-center justify-between gap-2.5">
          <div className="min-w-0">{picker}</div>
          <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
        </div>
        {lightbox}
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="composer flex w-full items-end gap-2.5 rounded-[22px] py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1 py-1">
        {imageRow}
        {area}
      </div>
      <div className="flex shrink-0 items-center gap-2.5 pb-0.5">
        {picker}
        {actions}
      </div>
      {lightbox}
    </div>
  );
}
