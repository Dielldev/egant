import { ChevronDown, ChevronRight, ClipboardList } from "lucide-react";
import { useState } from "react";
import type { PermissionReply } from "../lib/types";
import { Markdown } from "./Markdown";

/** Claude handing a finished plan back for approval — its ExitPlanMode tool,
 * which reaches the window as a permission request for itself. The plan is
 * the card's body; approving carries on in the mode picked (the CLI switches
 * as part of the approval), and "Keep planning" sends it back with what
 * should change, which the agent reads before planning again.
 *
 * `verdict` renders the same card settled, collapsed to its header — how the
 * plan reads in the transcript afterwards. */
export function PlanCard({
  plan,
  path,
  verdict,
  onAnswer,
  onOpenPlan,
}: {
  plan: string | null;
  /** The plan file the CLI wrote it to, when it said. */
  path: string | null;
  verdict?: "approved" | "sent-back" | null;
  onAnswer?: (reply: PermissionReply) => void;
  onOpenPlan?: (path: string) => void;
}) {
  const settled = verdict != null;
  const [open, setOpen] = useState(!settled);
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState("");
  // Flips the card read-only on click, before the store round-trips.
  const [sent, setSent] = useState(false);
  const locked = settled || sent;

  function approve(mode: string) {
    if (locked || !onAnswer) return;
    setSent(true);
    onAnswer({ decision: "approve-plan", mode });
  }

  function keepPlanning() {
    if (locked || !onAnswer) return;
    setSent(true);
    const text = feedback.trim();
    onAnswer({
      decision: "deny",
      feedback: text || "Keep planning — this plan isn't approved yet.",
    });
  }

  const title = settled
    ? verdict === "approved"
      ? "Plan approved"
      : "Plan sent back"
    : "Plan ready for review";

  return (
    <div className="flex w-full flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => settled && setOpen((v) => !v)}
          className={`flex min-w-0 flex-1 items-center gap-2 text-left ${settled ? "cursor-pointer" : "cursor-default"}`}
        >
          {settled && (
            <span className="shrink-0 text-[var(--faint)]">
              {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
            </span>
          )}
          <span className="shrink-0 text-[var(--faint)]">
            <ClipboardList size={14} strokeWidth={2} />
          </span>
          <span className="truncate text-[13px] leading-5 text-[var(--ink)]">{title}</span>
        </button>
        {path && onOpenPlan && (
          <button
            type="button"
            title={path}
            onClick={() => onOpenPlan(path)}
            className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            Open plan file
          </button>
        )}
      </div>

      {open && (
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[rgba(0,0,0,0.12)] px-3 py-2.5">
          {plan ? (
            <Markdown text={plan} />
          ) : (
            <span className="text-xs text-[var(--muted)]">
              The plan is in {path ?? "the plan file"}.
            </span>
          )}
        </div>
      )}

      {!settled &&
        (refining ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              rows={3}
              value={feedback}
              disabled={locked}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) keepPlanning();
                if (e.key === "Escape") setRefining(false);
              }}
              placeholder="What should change?"
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[rgba(0,0,0,0.15)] px-2.5 py-2 text-xs leading-5 text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={locked}
                onClick={() => setRefining(false)}
                className="cursor-pointer rounded-full bg-transparent px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-35"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={keepPlanning}
                className="cursor-pointer rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] hover:opacity-85 disabled:cursor-default disabled:opacity-35"
              >
                Send back
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={locked}
              onClick={() => setRefining(true)}
              className="mr-auto cursor-pointer rounded-full bg-transparent px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-35"
            >
              Keep planning
            </button>
            <button
              type="button"
              disabled={locked}
              title="Carry on in Manual: every edit asks first"
              onClick={() => approve("manual")}
              className="cursor-pointer rounded-full bg-[var(--bubble)] px-3 py-1.5 text-xs text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-35"
            >
              Approve · ask before edits
            </button>
            <button
              type="button"
              disabled={locked}
              title="Carry on in Accept edits: file edits go ahead, commands still ask"
              onClick={() => approve("acceptEdits")}
              className="cursor-pointer rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] hover:opacity-85 disabled:cursor-default disabled:opacity-35"
            >
              Approve · accept edits
            </button>
          </div>
        ))}
    </div>
  );
}
