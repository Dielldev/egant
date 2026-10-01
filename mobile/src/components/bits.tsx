import { AGENT_PROVIDER, fallbackName } from "@egant/lib/agents";
import { elapsedLabel, progressLine, statusVerb } from "@egant/lib/transcript";
import type { TurnProgress, TurnState } from "@egant/lib/types";
import { LogoLoader } from "@egant/components/Logo";
import { ProviderGlyph } from "@egant/components/ProviderLogo";
import { useNow } from "@egant/components/useNow";

/** The desktop's status line, minus its keyboard hint: the mark, a rotating
 * verb and the turn's own clock — or "Waiting on you" while a prompt is up,
 * and what the turn is busy with when the agent says (compacting, a retry's
 * countdown). */
export function StatusLine({
  state,
  startedAt,
  label: fixed,
  progress,
}: {
  state: TurnState;
  startedAt: number | null;
  /** Says this instead of the rotating verb ("Starting Claude Code"). */
  label?: string;
  /** What the turn is busy with, when the agent says. */
  progress?: TurnProgress | null;
}) {
  const now = useNow(500);
  const elapsed = startedAt == null ? 0 : Math.max(0, now - startedAt);
  const waitingOnUser = state === "awaiting_permission";
  const line = waitingOnUser ? null : progressLine(progress, now);
  const label =
    fixed ?? (waitingOnUser ? "Waiting on you" : (line?.label ?? statusVerb(startedAt ?? 0, elapsed)));
  const still = waitingOnUser || (line?.waiting ?? false);
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-1 pl-0.5 text-[14px] select-none">
      <LogoLoader width={22} />
      <span
        className={`min-w-[100px] whitespace-nowrap ${still ? "text-[var(--muted)]" : "shimmer"}`}
      >
        {label}…
      </span>
      <span className="tabular-nums text-[var(--faint)]">{elapsedLabel(elapsed)}</span>
      {line?.detail && <span className="truncate text-[var(--faint)]">· {line.detail}</span>}
    </div>
  );
}

/** The agent's mark, in the text colour around it — no brand colours. */
export function AgentGlyph({ agent, size = 14 }: { agent: string; size?: number }) {
  return <ProviderGlyph provider={AGENT_PROVIDER[agent] ?? agent} size={size} />;
}

export function agentLabel(agent: string, kind: "chat" | "cli"): string {
  return `${fallbackName(agent)}${kind === "cli" ? " CLI" : ""}`;
}

/** How long ago, in the coarsest unit that still says something. */
export function shortAgo(ms: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** The egant mark, drawn in the current text colour (the file version is
 * black on anything). */
export function Mark({ height = 14, className }: { height?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 622 456"
      height={height}
      width={(height * 622) / 456}
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M0 0H191L373 207V270L190 456H0V405H158L324 238L157 52H0Z" />
      <path d="M396 96H622V148H424L384 188L348 147Z" />
      <path d="M376 297L422 344H622V398H393L334 337Z" />
    </svg>
  );
}
