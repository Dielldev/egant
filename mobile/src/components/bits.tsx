import { FolderGit2, GitBranch } from "lucide-react";
import { AGENT_ACCENT, AGENT_PROVIDER, fallbackName } from "@egant/lib/agents";
import { elapsedLabel, statusVerb } from "@egant/lib/transcript";
import type { TurnState } from "@egant/lib/types";
import { LogoLoader } from "@egant/components/Logo";
import { ProviderGlyph } from "@egant/components/ProviderLogo";
import { useNow } from "@egant/components/useNow";
import type { Connection } from "../store";

/** The desktop's status line, minus its keyboard hint: the mark, a rotating
 * verb and the turn's own clock — or "Waiting on you" while a prompt is up. */
export function StatusLine({ state, startedAt }: { state: TurnState; startedAt: number | null }) {
  const now = useNow(500);
  const elapsed = startedAt == null ? 0 : Math.max(0, now - startedAt);
  const waiting = state === "awaiting_permission";
  const label = waiting ? "Waiting on you" : statusVerb(startedAt ?? 0, elapsed);
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 pl-0.5 text-xs select-none">
      <LogoLoader width={20} />
      <span
        className={`min-w-[100px] whitespace-nowrap ${waiting ? "text-[var(--muted)]" : "shimmer"}`}
      >
        {label}…
      </span>
      <span className="tabular-nums text-[var(--faint)]">{elapsedLabel(elapsed)}</span>
    </div>
  );
}

/** The agent's mark, in its accent colour, as the desktop sidebar draws it. */
export function AgentGlyph({ agent, size = 14 }: { agent: string; size?: number }) {
  return (
    <ProviderGlyph provider={AGENT_PROVIDER[agent] ?? agent} size={size} color={AGENT_ACCENT[agent]} />
  );
}

export function agentLabel(agent: string, kind: "chat" | "cli"): string {
  return `${fallbackName(agent)}${kind === "cli" ? " CLI" : ""}`;
}

/** Where a session runs: its worktree's branch, or the project's. */
export function BranchLine({
  branch,
  worktree,
}: {
  branch: string | null;
  worktree: { branch: string; name: string } | null;
}) {
  const name = worktree?.name ?? branch;
  if (!name) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[var(--muted)]/70">
      {worktree ? (
        <FolderGit2 size={12} strokeWidth={2} className="shrink-0" />
      ) : (
        <GitBranch size={12} strokeWidth={2} className="shrink-0" />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/** Green while the stream is live, amber while it reconnects, red when the
 * Mac can't be reached. */
export function ConnectionDot({ connection }: { connection: Connection }) {
  const color =
    connection === "live"
      ? "bg-emerald-400"
      : connection === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-[var(--danger)]";
  const label =
    connection === "live" ? "Connected" : connection === "connecting" ? "Connecting…" : "Offline";
  return <span title={label} aria-label={label} className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
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
