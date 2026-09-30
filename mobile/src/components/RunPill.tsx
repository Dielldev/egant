import { Eye, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { MobileSession, RunInfo } from "../api";
import { useMobile } from "../store";

/** How long a site is waited for after the agent was asked to start it: its
 * turn can end while the server is still compiling. */
const WAIT_MS = 30_000;
const POLL_MS = 2_500;

type Run = NonNullable<RunInfo["run"]>;

/** What the agent is asked. A website is to be started and left running — a
 * dev server in the foreground would hold the turn open until a tool's
 * timeout — and its address asked for, which also puts the port in the reply. */
export function runPrompt(run: Run): string {
  return run.label === "Run website"
    ? `Start the website with \`${run.command}\`. Leave it running in the background, then tell me the localhost URL it's on.`
    : `Run \`${run.command}\` and tell me what it prints.`;
}

const PILL =
  "press flex h-10 max-w-full items-center gap-2 rounded-full pr-4 pl-3.5 text-[14px] font-medium";

/** What a finished task offers next when the project says how to run itself:
 * "Run website · npm run dev" under the reply, like the desktop's pill — and
 * once the site is up on the Mac, "Preview website", which shows it inside the
 * app, over the chat, like a preview pane.
 *
 * Running is a message to the agent, which starts it with its own tools under
 * the chat's own permission mode: nothing here runs anything on the Mac. Which
 * command, and which port the site is on, are the Mac's answer (`/run`) — the
 * phone names neither. */
export function RunPill({
  session,
  canRun,
  lastUserText,
}: {
  session: MobileSession;
  /** The agent can be sent a message: the chat has not ended for good. */
  canRun: boolean;
  /** The newest thing the person said, which tells a run that was just asked
   * for from a run that never was. */
  lastUserText: string | null;
}) {
  const send = useMobile((s) => s.send);
  const openPreview = useMobile((s) => s.openPreview);
  const opening = useMobile((s) => s.previewBusy);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const id = session.id;

  // Answers can arrive out of order, or after the pill is gone.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const next = await api.runInfo(id);
      if (mine === latest.current) setInfo(next);
    } catch {
      // No pill beats a wrong one: the Mac may be asleep. The page's own
      // banner says when it can't be reached.
    }
  }, [id]);

  // Fresh whenever the pill appears — which is whenever a turn ends — and
  // whenever the phone comes back to this page from the website or another app.
  useEffect(() => {
    setInfo(null);
    setGaveUp(false);
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      latest.current++;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, load]);

  const run = info?.run ?? null;
  const site = info?.site ?? null;
  const asked = run != null && lastUserText === runPrompt(run);
  const starting = asked && site == null && !gaveUp;
  useEffect(() => {
    if (!starting) return;
    const poll = setInterval(() => void load(), POLL_MS);
    const stop = setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [starting, load]);

  if (site) {
    return (
      <button
        type="button"
        disabled={opening}
        onClick={() => void openPreview(id)}
        className={`${PILL} self-start bg-[var(--ink)] text-[var(--stage)] disabled:opacity-70`}
      >
        {opening ? (
          <Loader2 size={15} strokeWidth={2.2} className="shrink-0 animate-spin" />
        ) : (
          <Eye size={16} strokeWidth={2.2} className="shrink-0" />
        )}
        Preview website
        <span className="font-mono text-[12.5px] font-normal opacity-60">:{site.port}</span>
      </button>
    );
  }

  if (starting && run) {
    return (
      <div className={`${PILL} self-start bg-[var(--raised)] text-[var(--muted)]`}>
        <Loader2 size={14} strokeWidth={2.2} className="shrink-0 animate-spin" />
        Starting the website…
      </div>
    );
  }

  if (run && canRun) {
    return (
      <button
        type="button"
        onClick={() => void send(id, runPrompt(run))}
        className={`${PILL} self-start bg-[var(--raised)] text-[var(--ink)]`}
      >
        <Play size={14} strokeWidth={2.4} fill="currentColor" className="shrink-0" />
        <span className="shrink-0">{run.label}</span>
        <span className="min-w-0 truncate font-mono text-[12.5px] font-normal text-[var(--faint)]">
          {run.command}
        </span>
      </button>
    );
  }

  return null;
}
