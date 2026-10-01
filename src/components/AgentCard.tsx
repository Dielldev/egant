import { Bot, ChevronDown, ChevronRight } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { isAgentTool } from "../lib/transcript";
import type { Entry } from "../lib/types";
import { Markdown } from "./Markdown";
import { ToolActivityGroup } from "./ToolCards";

type ToolEntry = Extract<Entry, { kind: "tool" }>;

/** Every tool call a subagent made, its own subagents' included. */
function toolUses(steps: Entry[]): number {
  return steps.reduce(
    (count, step) => (step.kind === "tool" ? count + 1 + toolUses(step.children ?? []) : count),
    0,
  );
}

/** A subagent's run, as one card where the call that launched it (Claude's
 * `Task`) would be: "Agent · what it was asked · 4 tool uses", closed by
 * default. Open, it shows what the subagent did in its own words and tool
 * calls — which used to land in the conversation as if the main agent had
 * done them — and then what it reported back. Memoized like every row: a
 * running subagent redraws as its steps arrive, the settled ones never. */
export const AgentCard = memo(function AgentCard({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const input = (entry.input ?? {}) as { description?: unknown; prompt?: unknown };
  const description =
    typeof input.description === "string" && input.description.trim() !== ""
      ? input.description
      : null;
  const steps = entry.children ?? [];
  const uses = toolUses(steps);
  const running = entry.output == null && !entry.isError;
  const header = [
    "Agent",
    description,
    // A run saved before its steps were kept has none to count.
    uses > 0 || running ? `${uses} tool ${uses === 1 ? "use" : "uses"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={typeof input.prompt === "string" ? input.prompt : undefined}
        className="flex cursor-pointer items-center gap-1.5 py-0.5 text-left text-[13px]"
      >
        <span className="shrink-0 text-[var(--faint)]">
          {open ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
        </span>
        <Bot size={13} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{header}</span>
        {running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
        {entry.isError && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--danger)]" />}
      </button>
      {open && (
        <div className="relative mt-1 ml-[7px] flex flex-col gap-2 border-l border-[var(--border)] pl-4">
          <AgentSteps steps={steps} />
          {entry.output != null && entry.output.trim() !== "" && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--faint)]">
                {entry.isError ? "Failed" : "Reported back"}
              </span>
              <div className="text-[var(--muted)]">
                <Markdown text={entry.output} />
              </div>
            </div>
          )}
          {steps.length === 0 && entry.output == null && (
            <span className="text-[12px] text-[var(--faint)]">Starting…</span>
          )}
        </div>
      )}
    </div>
  );
});

/** A subagent's steps in order: runs of tool calls fold into one activity
 * block, as they do in the conversation; its words read as quieter text; a
 * subagent it launched gets a card of its own. */
function AgentSteps({ steps }: { steps: Entry[] }) {
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (step.kind === "tool" && isAgentTool(step.name)) {
      nodes.push(<AgentCard key={step.id || i} entry={step} />);
      i++;
      continue;
    }
    if (step.kind === "tool") {
      let j = i + 1;
      while (j < steps.length) {
        const next = steps[j]!;
        if (next.kind !== "tool" || isAgentTool(next.name)) break;
        j++;
      }
      nodes.push(<ToolActivityGroup key={`tools-${i}`} entries={steps.slice(i, j) as ToolEntry[]} />);
      i = j;
      continue;
    }
    if (step.kind === "assistant" && step.text.trim() !== "") {
      nodes.push(
        <div key={i} className="text-[var(--muted)]">
          <Markdown text={step.text} />
        </div>,
      );
    }
    i++;
  }
  return <>{nodes}</>;
}
