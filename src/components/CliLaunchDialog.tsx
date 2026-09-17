import { CornerDownLeft, Loader2, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AGENT_ACCENT, AGENT_PROVIDER, fallbackName } from "./AgentPicker";
import { ProviderLogo } from "./ProviderLogo";
import { useEgant } from "../store";

/** The confirmation between picking an agent and having its CLI open.
 *
 * Two different paths arrive here and the dialog says which: an agent egant
 * has no chat harness for (Pi, Goose, Amp — the CLI is the only way to run
 * it at all), and one it does, where the user has turned the chat UI off and
 * is asking for the raw CLI instead. Neither should happen on a stray click
 * in the agent picker, which is the whole reason this is a dialog and not an
 * immediate action — a terminal that appears with an agent already running
 * in it is a surprise worth one keystroke.
 *
 * What it does *not* do is warn. Opening a CLI is a normal thing to want;
 * the dialog names the command, says the files and git panel still work, and
 * gets out of the way. */
export function CliLaunchDialog() {
  const agent = useEgant((s) => s.cliLaunch);
  const cancel = useEgant((s) => s.cancelCliLaunch);
  const start = useEgant((s) => s.startCliSession);
  const catalog = useEgant((s) => s.catalog);
  const agents = useEgant((s) => s.agents);
  const openSettings = useEgant((s) => s.openSettings);
  const [starting, setStarting] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);

  // Start takes focus on open, so ⏎ launches without reaching for the mouse.
  // Esc is global rather than on the panel: the click that opened this came
  // from the agent picker, and focus may not have arrived yet.
  useEffect(() => {
    if (!agent) return;
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agent, cancel]);

  // A dialog left open from a previous pick must not keep a spinner from it.
  useEffect(() => {
    if (!agent) setStarting(false);
  }, [agent]);

  if (!agent) return null;

  const entry = catalog.find((c) => c.id === agent);
  const status = agents.find((a) => a.id === agent);
  const name = entry?.name ?? status?.name ?? fallbackName(agent);
  // Straight from the catalog — the backend is the only thing that knows a
  // CLI needs an argument to open its session rather than its help.
  const command = entry?.launchCommand ?? status?.cli ?? agent;
  const installed = entry?.installed ?? status?.installed ?? true;
  // Whether this agent could have run in the chat UI. It's the difference
  // between "this is the only way to run it" and "you asked for the raw CLI".
  const optedOut = entry?.chatUi ?? false;

  const launch = async () => {
    setStarting(true);
    const ok = await start(agent);
    if (!ok) setStarting(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6 backdrop-blur-[2px]"
      // A click on the backdrop is a cancel, the same as Esc. The panel below
      // stops the event so a click inside it is never one.
      onMouseDown={cancel}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <ProviderLogo provider={AGENT_PROVIDER[agent] ?? entry?.vendor ?? agent} size={38} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-[var(--ink)]">
              Open {name} in a terminal
            </div>
            <div className="mt-0.5 text-[12px] leading-[1.45] text-[var(--muted)]">
              {optedOut
                ? `You've turned egant's chat UI off for ${name}, so this session runs its CLI directly.`
                : `${name} is a terminal-only CLI — egant can't render its turns as chat, so this session runs it directly.`}
            </div>
          </div>
        </div>

        <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
          <TerminalSquare size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
          <code
            className="min-w-0 flex-1 truncate font-mono text-[12px]"
            style={{ color: AGENT_ACCENT[agent] ?? "var(--ink)" }}
          >
            {command}
          </code>
        </div>

        <p className="mx-5 mt-3 text-[11.5px] leading-[1.5] text-[var(--faint)]">
          It opens in this project's folder, and the workspace panel — files,
          changes and extra terminals — keeps working beside it.
        </p>

        {!installed && (
          <button
            type="button"
            onClick={() => {
              cancel();
              openSettings("agents", agent);
            }}
            className="mx-5 mt-3 flex w-[calc(100%-2.5rem)] cursor-pointer items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-left text-[11px] text-amber-200 hover:bg-amber-400/15"
          >
            <span className="min-w-0 flex-1 truncate">
              {name} isn't installed on this machine.
            </span>
            <span className="shrink-0 font-medium underline underline-offset-2">Install</span>
          </button>
        )}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <button
            type="button"
            onClick={cancel}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            ref={startRef}
            type="button"
            disabled={starting || !installed}
            onClick={() => void launch()}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-45"
          >
            {starting ? (
              <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <CornerDownLeft size={12} strokeWidth={2.5} />
            )}
            {starting ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
