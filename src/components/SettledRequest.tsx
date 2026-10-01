import { memo } from "react";
import { answeredPicks, ASK_USER_QUESTION, askQuestions, planOf } from "../lib/transcript";
import type { Entry } from "../lib/types";
import { PlanCard } from "./PlanCard";
import { QuestionCard } from "./QuestionCard";
import { ToolCard } from "./ToolCards";

/** A question or a plan once it is settled: the same card, read-only, with
 * what the user answered. Nothing while it is still open — the live card at
 * the foot of the transcript stands for it then — and nothing for one a
 * turn abandoned before anyone answered. Memoized: settled, it never
 * changes, and the transcript re-renders on every streamed token. */
export const SettledRequest = memo(function SettledRequest({
  entry,
  onOpenPlan,
}: {
  entry: Extract<Entry, { kind: "tool" }>;
  /** Opens the plan's file; left out where there is nowhere to open it
   * (the phone). */
  onOpenPlan?: (path: string) => void;
}) {
  if (entry.output == null) return null;
  if (entry.name === ASK_USER_QUESTION) {
    const questions = askQuestions(entry.input);
    if (questions.length === 0) return <ToolCard entry={entry} />;
    return (
      <QuestionCard
        questions={questions}
        answered={entry.isError ? null : answeredPicks(entry.output)}
        skipped={entry.isError}
      />
    );
  }
  return (
    <PlanCard
      {...planOf(entry.input)}
      verdict={entry.isError ? "sent-back" : "approved"}
      onOpenPlan={onOpenPlan}
    />
  );
});
