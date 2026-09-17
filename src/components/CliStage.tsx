import { useEgant } from "../store";
import type { SessionInfo } from "../lib/types";
import { AGENT_ACCENT, AGENT_PROVIDER, fallbackName } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { cliTerminalKey, TerminalPane } from "./TerminalPane";

/** What a CLI session shows instead of a transcript and a composer: the
 * agent's own CLI, full-bleed, running in the session's project folder.
 *
 * There is no composer here on purpose. The CLI already has one — its own
 * prompt — and a second input above it would be a box that either did
 * nothing or typed into the terminal from a distance. Everything else the
 * stage offers is unchanged: the header names the session, the tab strip
 * still opens files and diffs beside it, and the workspace panel reads the
 * same working directory it always did.
 *
 * The terminal is keyed by session id through `TerminalPane`'s own registry,
 * so switching to another conversation and back finds the same scrollback
 * and the same running agent rather than a second one. */
export function CliStage({ session }: { session: SessionInfo }) {
  const catalog = useEgant((s) => s.catalog);
  const entry = catalog.find((c) => c.id === session.agent);
  const name = entry?.name ?? fallbackName(session.agent);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-1 pb-2 text-[11px] text-[var(--faint)]">
        <ProviderGlyph
          provider={AGENT_PROVIDER[session.agent] ?? entry?.vendor ?? session.agent}
          size={12}
          color={AGENT_ACCENT[session.agent]}
        />
        <span className="shrink-0 text-[var(--muted)]">{name} CLI</span>
        <span className="min-w-0 flex-1 truncate">{session.cwd}</span>
      </div>
      <TerminalPane
        tabId={cliTerminalKey(session.id)}
        cwd={session.cwd}
        agent={session.agent}
        label={name}
        active
      />
    </div>
  );
}
