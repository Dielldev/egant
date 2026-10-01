import { Loader2, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import type { RevertPlan } from "../lib/types";
import { useEgant } from "../store";

/** What reverting does to a file, in the words of what the turn did to it. */
const ACTION: Record<RevertPlan["files"][number]["change"], { verb: string; tone: string }> = {
  modified: { verb: "Restore", tone: "text-[var(--muted)]" },
  added: { verb: "Delete", tone: "text-[var(--danger)]" },
  deleted: { verb: "Bring back", tone: "text-[#6bc46d]" },
};

/** "Revert this turn", asked first: the files the turn changed and what
 * happens to each — restored, deleted (the turn made it), brought back (the
 * turn deleted it) — and a warning for any changed again since, whose later
 * changes go too. Only files move; the conversation stays, so the agent goes
 * on believing its edits are there until it is told. */
export function RevertTurnDialog({
  sessionId,
  turn,
  onClose,
}: {
  sessionId: number;
  /** Which message's turn, counted from 0. */
  turn: number;
  onClose: () => void;
}) {
  const showNotice = useEgant((s) => s.showNotice);
  const refreshChanges = useEgant((s) => s.refreshChanges);
  const [plan, setPlan] = useState<RevertPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .previewTurnRevert(sessionId, turn)
      .then((next) => {
        if (live) setPlan(next);
      })
      .catch((e: unknown) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [sessionId, turn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const revert = async () => {
    setReverting(true);
    try {
      const result = await api.revertTurn(sessionId, turn);
      showNotice(
        result.files === 1 ? "Reverted 1 file from that turn" : `Reverted ${result.files} files from that turn`,
      );
      refreshChanges();
      onClose();
    } catch (e) {
      setError(String(e));
      setReverting(false);
    }
  };

  const later = new Set(plan?.changedSince ?? []);
  const nothing = plan != null && plan.files.length === 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl"
      >
        <div className="px-5 pt-5">
          <div className="text-[14px] font-semibold text-[var(--ink)]">Revert this turn?</div>
          <div className="mt-0.5 text-[12px] leading-[1.45] text-[var(--muted)]">
            Puts the files it changed back the way they were before it. The conversation stays as
            it is — tell the agent if it should know.
          </div>
        </div>

        <div className="mx-5 mt-4 max-h-[260px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-[12px]">
          {error ? (
            <div className="text-[var(--danger)]">{error}</div>
          ) : plan == null ? (
            <div className="flex items-center gap-2 text-[var(--faint)]">
              <Loader2 size={12} className="animate-spin" /> Comparing…
            </div>
          ) : nothing ? (
            <div className="text-[var(--faint)]">This turn didn't change any files.</div>
          ) : (
            plan.files.map((file) => (
              <div key={file.path} className="flex min-w-0 items-center gap-2 py-0.5">
                <span className={`w-[68px] shrink-0 ${ACTION[file.change].tone}`}>
                  {ACTION[file.change].verb}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--ink)]" title={file.path}>
                  {file.path}
                </span>
                {later.has(file.path) && (
                  <span title="Changed again since this turn — those later changes are lost too">
                    <TriangleAlert size={12} className="shrink-0 text-amber-300" />
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        {later.size > 0 && (
          <p className="mx-5 mt-3 flex items-start gap-1.5 text-[11.5px] leading-[1.5] text-amber-200">
            <TriangleAlert size={12} className="mt-0.5 shrink-0" />
            {later.size === 1 ? "1 of these files has" : `${later.size} of these files have`} changed
            again since this turn. Reverting loses those later changes too.
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={plan == null || nothing || reverting || error != null}
            onClick={() => void revert()}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-45"
          >
            {reverting ? (
              <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <Undo2 size={12} strokeWidth={2.5} />
            )}
            {reverting ? "Reverting…" : "Revert"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
