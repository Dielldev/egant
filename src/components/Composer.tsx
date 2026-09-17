import { ArrowUp, Paperclip, Square, TerminalSquare, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pickAttachments } from "../lib/api";
import { formatContext } from "../lib/types";
import { prettyClaudeModelId } from "../lib/transcript";
import { selectNextAgent, useEgant, usesChatUi } from "../store";
import { AGENT_ACCENT, AGENT_PROVIDER, AgentPicker, agentName } from "./AgentPicker";
import { ModeInfo } from "./ModeInfo";
import { ProviderGlyph } from "./ProviderLogo";
import { UsageMeter } from "./UsageMeter";

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
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

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

  const submit = () => {
    // In CLI mode the button is the way into the terminal, not a send.
    if (cliAgent) {
      askCliLaunch(cliAgent);
      return;
    }
    if (!hasText || ended) return;
    if (hero || sessionId == null) void sendOnLaunch(text);
    else void send(sessionId, text);
    setText("");
    requestAnimationFrame(() => areaRef.current?.focus());
  };

  const attach = async () => {
    const paths = await pickAttachments().catch(() => [] as string[]);
    if (paths.length === 0) return;
    const mention = paths.map((p) => `@${p}`).join(" ");
    setText((prev) => (prev.trim() === "" ? `${mention} ` : `${prev.trimEnd()} ${mention} `));
    areaRef.current?.focus();
  };

  const area = (
    <textarea
      ref={areaRef}
      value={text}
      rows={hero ? 3 : 1}
      disabled={ended || cliAgent != null}
      onChange={(e) => setText(e.target.value)}
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
      className="max-h-[240px] w-full resize-none bg-transparent text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--faint)] disabled:opacity-50"
    />
  );

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
        className="shrink-0 cursor-pointer rounded-full p-1.5 text-[var(--muted)] hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--ink)]"
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
            cliAgent || (hasText && !ended)
              ? "bg-[#f2f2f5] text-[#0c0c0e]"
              : "bg-[rgba(255,255,255,0.1)] text-[var(--faint)]"
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

  if (hero) {
    return (
      <div className="composer w-full rounded-2xl px-5 py-4">
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
        {area}
        {/* Picker left, actions right — matches the reference bar where the
          model (`Fable 5.1 High · 200K`) sits opposite the paperclip/send. */}
        <div className="mt-4 flex min-w-0 items-center justify-between gap-2.5">
          <div className="min-w-0">{picker}</div>
          <div className="flex shrink-0 items-center gap-2.5">{actions}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="composer flex w-full items-end gap-2.5 rounded-[22px] py-2 pr-2 pl-4">
      <div className="min-w-0 flex-1 py-1">{area}</div>
      <div className="flex shrink-0 items-center gap-2.5 pb-0.5">
        {picker}
        {actions}
      </div>
    </div>
  );
}
