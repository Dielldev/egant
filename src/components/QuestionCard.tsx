import { MessageCircleQuestion } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { modShortcut } from "../lib/platform";
import type { AskQuestion, PermissionReply } from "../lib/types";
import { CustomOptionRow, OptionRow } from "./DecisionPrompt";

const OTHER = "__other__";

/** Claude putting questions to the user — its AskUserQuestion tool, which
 * reaches the window as a permission request for itself. One block per
 * question (header chip, options with their descriptions, checkboxes when it
 * takes several, and "Something else…" for a free answer), one Submit for
 * all of them: the answers go back as part of the tool's input, which is the
 * only way the agent hears them. Skip refuses the tool, and the agent carries
 * on without an answer.
 *
 * `answered` renders the same card read-only, with the picks the CLI reported
 * back — how the question reads in the transcript once it is settled. */
export function QuestionCard({
  questions,
  answered,
  skipped,
  onAnswer,
}: {
  questions: AskQuestion[];
  /** Question text → what was answered. Set for a settled question. */
  answered?: Record<string, string> | null;
  /** The question was refused rather than answered. */
  skipped?: boolean;
  onAnswer?: (reply: PermissionReply) => void;
}) {
  const groupId = useId();
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // Flips the card read-only on click, before the store round-trips.
  const [sent, setSent] = useState(false);
  const settled = answered != null || skipped === true;
  const locked = settled || sent;

  const answerFor = (q: AskQuestion): string | string[] | null => {
    const chosen = picks[q.question] ?? [];
    const labels = chosen.filter((label) => label !== OTHER);
    const text = (other[q.question] ?? "").trim();
    const all = chosen.includes(OTHER) && text ? [...labels, text] : labels;
    if (all.length === 0) return null;
    return q.multiSelect ? all : all[0]!;
  };
  const complete = questions.length > 0 && questions.every((q) => answerFor(q) !== null);

  function toggle(q: AskQuestion, label: string) {
    setPicks((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...prev, [q.question]: next };
    });
  }

  function submit() {
    if (!complete || locked || !onAnswer) return;
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) answers[q.question] = answerFor(q)!;
    setSent(true);
    onAnswer({ decision: "answer", answers });
  }

  function skip() {
    if (locked || !onAnswer) return;
    setSent(true);
    onAnswer({ decision: "deny", feedback: "The user skipped the question." });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  }

  /** For a settled card: which options the reported answer names, and any
   * free text left over (a multi-select answer comes back comma-joined). */
  const settledPicks = (q: AskQuestion): { labels: string[]; text: string | null } => {
    const raw = answered?.[q.question];
    if (raw == null) return { labels: [], text: null };
    const known = new Set(q.options.map((o) => o.label));
    if (known.has(raw)) return { labels: [raw], text: null };
    const parts = q.multiSelect ? raw.split(", ") : [raw];
    const labels = parts.filter((part) => known.has(part));
    const rest = parts.filter((part) => !known.has(part)).join(", ");
    return { labels, text: rest || null };
  };

  return (
    <div
      onKeyDown={onKeyDown}
      className="flex w-full flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[var(--faint)]">
          <MessageCircleQuestion size={14} strokeWidth={2} />
        </span>
        <span className="text-[13px] leading-5 text-[var(--ink)]">
          {settled
            ? skipped
              ? "Question skipped"
              : "Question answered"
            : questions.length === 1
              ? "Claude has a question"
              : `Claude has ${questions.length} questions`}
        </span>
      </div>

      {questions.map((q, qi) => {
        const multi = q.multiSelect === true;
        const shown = settledPicks(q);
        const chosen = picks[q.question] ?? [];
        const isChecked = (label: string) =>
          settled ? shown.labels.includes(label) : chosen.includes(label);
        const otherChecked = settled ? shown.text != null : chosen.includes(OTHER);
        return (
          <div key={q.question} className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2">
              {q.header && (
                <span className="shrink-0 rounded-md bg-[var(--bubble)] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--muted)] uppercase">
                  {q.header}
                </span>
              )}
              <span className="text-[13px] leading-5 text-[var(--ink)]">{q.question}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((option) => (
                <OptionRow
                  key={option.label}
                  groupName={`${groupId}-${qi}`}
                  option={{ id: option.label, label: option.label, description: option.description }}
                  multi={multi}
                  checked={isChecked(option.label)}
                  disabled={locked}
                  dimmed={settled && !isChecked(option.label)}
                  onChange={() => toggle(q, option.label)}
                />
              ))}
              {(!settled || shown.text != null) && (
                <CustomOptionRow
                  groupName={`${groupId}-${qi}`}
                  multi={multi}
                  checked={otherChecked}
                  disabled={locked}
                  dimmed={false}
                  text={settled ? (shown.text ?? "") : (other[q.question] ?? "")}
                  onToggle={() => toggle(q, OTHER)}
                  onTextChange={(text) => setOther((prev) => ({ ...prev, [q.question]: text }))}
                />
              )}
            </div>
          </div>
        );
      })}

      {!settled && (
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-[var(--faint)]">
            {questions.length > 1 ? "Answer each question" : "Pick an answer"}
          </span>
          <button
            type="button"
            disabled={locked}
            onClick={skip}
            className="cursor-pointer rounded-full bg-transparent px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-35"
          >
            Skip
          </button>
          <button
            type="button"
            disabled={!complete || locked}
            onClick={submit}
            title={`Submit · ${modShortcut("⏎")}`}
            className="cursor-pointer rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-35 disabled:hover:opacity-35"
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}
