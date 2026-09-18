import { useEffect } from "react";
import { useEgant } from "../store";

/** The one line the window says on its own initiative.
 *
 * Today it is only ever a worktree that outlived the conversation it was made
 * for, which is why it carries an action: the user has just been told what is
 * in the checkout, and "delete it anyway" is only a fair question once they
 * have. Neutral rather than red — nothing went wrong, something was kept.
 *
 * Lives on the stage rather than inside the transcript so it survives closing
 * the last conversation, which is exactly when it has something to say. */
export function NoticeToast() {
  const notice = useEgant((s) => s.notice);
  const dismissNotice = useEgant((s) => s.dismissNotice);
  const discardKeptWorktree = useEgant((s) => s.discardKeptWorktree);

  // Longer than the error toast's five seconds: this one names a path the user
  // may want to copy, and offers something to click.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissNotice(), 12000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  if (!notice) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-6">
      <div className="row-in pointer-events-auto flex max-w-[620px] items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-xs text-[var(--ink)] shadow-lg">
        <span className="min-w-0 flex-1 break-words">{notice.text}</span>
        {notice.worktree && (
          <button
            type="button"
            title={`Delete ${notice.worktree.path} and its branch`}
            onClick={() => {
              if (notice.worktree) void discardKeptWorktree(notice.worktree);
            }}
            className="shrink-0 cursor-pointer rounded-md px-2 py-1 font-medium text-[var(--danger)] hover:bg-[var(--hover)]"
          >
            Delete it anyway
          </button>
        )}
        <button
          type="button"
          title="Dismiss"
          onClick={dismissNotice}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
