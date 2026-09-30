import { ArrowDown, Folder, FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Checkout } from "../api";
import { chooseCheckout, chosenCheckout, useCheckouts } from "../checkouts";
import { usePrefs } from "../prefs";
import { useMobile } from "../store";
import { Choice, Sheet } from "./Sheet";

/** What a checkout is called: the folder is "Project folder", a worktree its
 * short name. */
export function checkoutName(checkout: Checkout): string {
  return checkout.kind === "project" ? "Project folder" : (checkout.name ?? checkout.branch ?? "worktree");
}

/** "3 behind main", "1 uncommitted" — the counts worth a glance. */
function facts(checkout: Checkout, mainRef: string | null | undefined): string[] {
  const parts: string[] = [];
  if (checkout.dirty > 0) parts.push(`${checkout.dirty} uncommitted`);
  if (checkout.behind) {
    parts.push(
      checkout.kind === "project"
        ? `${checkout.behind} behind ${checkout.upstream ?? "remote"}`
        : `${checkout.behind} behind ${mainRef ?? "main"}`,
    );
  }
  if (checkout.ahead) parts.push(`${checkout.ahead} ahead`);
  return parts;
}

/** Where the next chat runs. The project's folder or a worktree that is
 * already there — making a new worktree is done on the Mac. When the folder
 * has fallen behind its remote, the banner offers the Mac a fast-forward. */
export function CheckoutSheet({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
}) {
  const list = useCheckouts((s) => s.byProject[projectId]);
  const loading = useCheckouts((s) => s.loading[projectId] === true);
  const pulling = useCheckouts((s) => s.pulling);
  const load = useCheckouts((s) => s.load);
  const pull = useCheckouts((s) => s.pull);
  const showToast = useMobile((s) => s.showToast);
  const machine = useMobile((s) => s.machineName);
  // Subscribed so the tick follows the choice.
  usePrefs((s) => s.checkouts);
  const [confirming, setConfirming] = useState(false);

  // Opening it asks the remote too, so "behind" is current.
  useEffect(() => {
    if (open) void load(projectId, { fetch: true, force: true });
    else setConfirming(false);
  }, [open, projectId, load]);

  const chosen = chosenCheckout(projectId, list);
  const folder = list?.checkouts.find((c) => c.kind === "project");
  const behind = folder?.behind ?? 0;

  const doPull = async () => {
    const error = await pull(projectId);
    setConfirming(false);
    showToast(error ?? `Pulled — ${folder?.branch ?? "main"} is up to date.`);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Where to work">
      <div className="pb-2">
        {behind > 0 && folder && (
          <div className="mb-3 rounded-[18px] bg-[var(--raised-2)] p-4">
            <div className="flex items-start gap-3">
              <ArrowDown size={18} strokeWidth={2.4} className="mt-0.5 shrink-0 text-amber-500 dark:text-amber-300" />
              <div className="min-w-0 flex-1">
                <div className="text-[15.5px] font-medium text-[var(--ink)]">
                  {folder.branch ?? "The project folder"} is {behind} {behind === 1 ? "commit" : "commits"} behind
                </div>
                <div className="mt-0.5 text-[13px] leading-[18px] text-[var(--muted)]">
                  {folder.upstream ? `${folder.upstream} has changes ` : "The remote has changes "}
                  {machine || "your Mac"} hasn't pulled yet.
                  {folder.dirty > 0 && " It has uncommitted files of its own, so a pull will be refused."}
                </div>
              </div>
            </div>
            {confirming ? (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={pulling}
                  onClick={() => setConfirming(false)}
                  className="press h-10 flex-1 rounded-full bg-[var(--stage)] text-[15px] font-medium text-[var(--ink)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={pulling}
                  onClick={() => void doPull()}
                  className="press h-10 flex-1 rounded-full bg-[var(--ink)] text-[15px] font-semibold text-[var(--stage)] disabled:opacity-60"
                >
                  {pulling ? "Pulling…" : `Fast-forward on ${machine || "Mac"}`}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="press mt-3 h-10 w-full rounded-full bg-[var(--ink)] text-[15px] font-semibold text-[var(--stage)]"
              >
                Pull
              </button>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-[18px] bg-[var(--raised-2)]/60">
          {(list?.checkouts ?? []).map((checkout) => {
            const details = facts(checkout, list?.mainRef);
            return (
              <Choice
                key={`${checkout.kind}:${checkout.branch}`}
                leading={
                  checkout.kind === "project" ? (
                    <Folder size={19} strokeWidth={1.9} className="text-[var(--muted)]" />
                  ) : (
                    <FolderGit2 size={19} strokeWidth={1.9} className="text-[var(--muted)]" />
                  )
                }
                label={checkoutName(checkout)}
                detail={
                  <>
                    <span className="inline-flex items-center gap-1">
                      <GitBranch size={12} strokeWidth={2.2} className="shrink-0" />
                      {checkout.branch ?? "detached"}
                    </span>
                    {details.length > 0 && (
                      <span className={checkout.behind ? "text-amber-600 dark:text-amber-300" : ""}>
                        {" · "}
                        {details.join(" · ")}
                      </span>
                    )}
                  </>
                }
                selected={chosen != null && chosen.kind === checkout.kind && chosen.branch === checkout.branch}
                onClick={() => {
                  chooseCheckout(projectId, checkout.kind === "worktree" ? checkout.branch : null);
                  onClose();
                }}
              />
            );
          })}
          {!list && (
            <div className="px-4 py-6 text-center text-[14px] text-[var(--muted)]">
              {loading ? "Reading your Mac's checkouts…" : "Couldn't read them."}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 px-2 pt-3 text-[12.5px] leading-snug text-[var(--faint)]">
          <span className="min-w-0 flex-1">
            {list?.fetchError ? `${list.fetchError} Showing what ${machine || "your Mac"} last saw. ` : ""}
            New chats run in one of these. To make a new worktree, do it on {machine || "your Mac"}.
          </span>
          <button
            type="button"
            aria-label="Check again"
            onClick={() => void load(projectId, { fetch: true, force: true })}
            className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--muted)]"
          >
            <RefreshCw size={15} strokeWidth={2.1} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
    </Sheet>
  );
}
