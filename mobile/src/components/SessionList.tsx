import { LogOut, MoreHorizontal, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { projectColor } from "@egant/lib/transcript";
import { useNow } from "@egant/components/useNow";
import type { MobileSession } from "../api";
import { useMobile } from "../store";
import { AgentGlyph, BranchLine, ConnectionDot, shortAgo } from "./bits";
import { ConnectionBanner } from "./ConnectionBanner";
import { InstallHint } from "./InstallHint";
import { Toast } from "./Toast";

/** Every session on the Mac, newest activity first — with the ones blocked on
 * an answer pinned above the rest, since unblocking agents is most of what a
 * phone is for. */
export function SessionList() {
  const sessions = useMobile((s) => s.sessions);
  const machine = useMobile((s) => s.machineName);
  const connection = useMobile((s) => s.connection);
  const navigate = useMobile((s) => s.navigate);
  const now = useNow(30_000);

  const sorted = [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  const needsYou = sorted.filter((session) => session.pendingCount > 0);
  const rest = sorted.filter((session) => session.pendingCount === 0);

  return (
    <div className="flex h-full flex-col">
      <header className="safe-top shrink-0 border-b border-[var(--border)]">
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-[var(--ink)]">Sessions</div>
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
              <ConnectionDot connection={connection} />
              <span className="truncate">{machine}</span>
            </div>
          </div>
          <MachineMenu machine={machine} />
        </div>
      </header>
      <ConnectionBanner />
      <div className="safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pt-2">
        <div className="px-1">
          <Toast />
        </div>
        <InstallHint />
        {needsYou.length > 0 && (
          <Section label="Needs you">
            {needsYou.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                machine={machine}
                now={now}
                onOpen={() => navigate(session.id)}
              />
            ))}
          </Section>
        )}
        {rest.length > 0 && (
          <Section label={needsYou.length > 0 ? "Everything else" : "Recent"}>
            {rest.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                machine={machine}
                now={now}
                onOpen={() => navigate(session.id)}
              />
            ))}
          </Section>
        )}
        {sessions.length === 0 && (
          <div className="px-6 py-16 text-center text-[13px] text-[var(--muted)]">
            No sessions on {machine || "your Mac"} yet. Start one there and it appears here.
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

/** One session as the desktop sidebar draws it: `project @ machine` over the
 * agent's mark and the title, the branch under that, and in the corner what
 * it is doing now. */
function SessionRow({
  session,
  machine,
  now,
  onOpen,
}: {
  session: MobileSession;
  machine: string;
  now: number;
  onOpen: () => void;
}) {
  const waiting = session.pendingCount > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left active:bg-[var(--hover)]"
    >
      <div className="flex w-full items-center gap-2">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: projectColor(session.projectHue) }}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-[var(--muted)]/70">
          {session.projectName} @ {machine}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium">
          {waiting ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
              <span className="text-amber-600 dark:text-amber-300">
                {session.pendingCount === 1 ? "Needs approval" : `${session.pendingCount} approvals`}
              </span>
            </>
          ) : session.busy ? (
            <>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--busy)]" />
              <span className="text-[var(--busy)]">Working</span>
            </>
          ) : (
            <span className="text-[var(--faint)]">{shortAgo(session.lastActivityMs, now)}</span>
          )}
        </span>
      </div>
      <div className="flex w-full items-center gap-2">
        <span className="shrink-0 opacity-80">
          <AgentGlyph agent={session.agent} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] leading-5 text-[var(--ink)]">
          {session.title}
        </span>
        {session.kind === "cli" && (
          <TerminalSquare size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        )}
      </div>
      <BranchLine branch={session.branch} worktree={session.worktree} />
    </button>
  );
}

/** The one thing to do with the connection itself: forget this Mac. */
function MachineMenu({ machine }: { machine: string }) {
  const device = useMobile((s) => s.device);
  const forget = useMobile((s) => s.forget);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Connection"
        onClick={() => {
          setOpen((v) => !v);
          setConfirming(false);
        }}
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-[var(--muted)] active:bg-[var(--hover)]"
      >
        <MoreHorizontal size={18} strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="menu absolute top-10 right-0 z-40 w-64 rounded-xl p-3 text-[13px]">
            <div className="text-[var(--ink)]">{machine}</div>
            <div className="mt-0.5 text-[12px] text-[var(--faint)]">
              This phone is paired as “{device?.name ?? "phone"}”.
            </div>
            {confirming ? (
              <div className="mt-3 flex flex-col gap-2">
                <div className="text-[12px] text-[var(--muted)]">
                  Forget {machine}? You'll need a new QR code from it to connect again.
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void forget()}
                    className="flex-1 cursor-pointer rounded-lg bg-[rgba(224,112,112,0.14)] py-2 text-[var(--danger)]"
                  >
                    Forget
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="flex-1 cursor-pointer rounded-lg bg-[var(--bubble)] py-2 text-[var(--ink)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="mt-3 flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[var(--danger)] active:bg-[var(--hover)]"
              >
                <LogOut size={14} strokeWidth={2} />
                Forget this Mac
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
