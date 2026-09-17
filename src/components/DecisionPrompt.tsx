import { Check, MessageCircleQuestion } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import type { DecisionOption, DecisionRequest, DecisionResponse } from "../lib/types";

const CUSTOM_OPTION_ID = "__custom__";

interface DecisionPromptProps {
  prompt: DecisionRequest;
  /** `null` while still awaiting the user; once set, the card renders
   * read-only with the picks highlighted and nothing left clickable. */
  response: DecisionResponse | null;
  onSubmit: (response: DecisionResponse) => void;
}

/** An agent-initiated decision, rendered inline in the transcript like any
 * other entry: a question, single- or multi-select options, an optional
 * free-text option, and a Confirm button. Answering disables the card in
 * place and shows the pick — this one component renders both states, driven
 * entirely by `response`.
 *
 * Kept generic on purpose: `prompt.type` is `"decision"` today, but
 * `AgentRequest` (lib/types.ts) is a union built to grow — a future kind adds
 * its own card and a case in `AgentRequestCard` (TranscriptView.tsx), never a
 * change here. */
export function DecisionPrompt({ prompt, response, onSubmit }: DecisionPromptProps) {
  const groupName = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState("");
  // Set on Confirm so the card flips to its completed state immediately,
  // rather than waiting a render for `response` to round-trip back down from
  // the store — `response` then takes over seamlessly once it arrives.
  const [localResponse, setLocalResponse] = useState<DecisionResponse | null>(null);

  const answered = response ?? localResponse;
  const multi = prompt.selectionMode === "multiple";
  const hasCustom = selected.has(CUSTOM_OPTION_ID);
  const pickedCount = selected.size - (hasCustom ? 1 : 0);
  const canSubmit = pickedCount > 0 || (hasCustom && customText.trim().length > 0);

  function toggle(optionId: string) {
    setSelected((prev) => {
      if (multi) {
        const next = new Set(prev);
        if (next.has(optionId)) next.delete(optionId);
        else next.add(optionId);
        return next;
      }
      return prev.has(optionId) ? prev : new Set([optionId]);
    });
  }

  function submit() {
    if (!canSubmit) return;
    const trimmedCustom = customText.trim();
    const result: DecisionResponse = {
      type: "decision",
      selectedOptionIds: [...selected].filter((id) => id !== CUSTOM_OPTION_ID),
      ...(hasCustom && trimmedCustom ? { customText: trimmedCustom } : {}),
    };
    setLocalResponse(result);
    onSubmit(result);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Enter confirms from anywhere in the card except the free-text field,
    // where Enter should type a newline-free confirm only via the button —
    // left to its own default (nothing) so it never fights the input.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) submit();
  }

  return (
    <div
      onKeyDown={onKeyDown}
      className="flex w-full flex-col gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-[var(--faint)]">
          <MessageCircleQuestion size={14} strokeWidth={2} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="text-[13px] leading-5 text-[var(--ink)]">{prompt.title}</div>
          {prompt.description && (
            <div className="text-xs leading-5 text-[var(--muted)]">{prompt.description}</div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        {prompt.options.map((option) => (
          <OptionRow
            key={option.id}
            groupName={groupName}
            option={option}
            multi={multi}
            checked={answered ? answered.selectedOptionIds.includes(option.id) : selected.has(option.id)}
            disabled={answered != null}
            dimmed={answered != null && !answered.selectedOptionIds.includes(option.id)}
            onChange={() => toggle(option.id)}
          />
        ))}
        {prompt.allowCustomInput && (!answered || answered.customText) && (
          <CustomOptionRow
            groupName={groupName}
            multi={multi}
            checked={answered ? answered.customText != null : hasCustom}
            disabled={answered != null}
            dimmed={answered != null && answered.customText == null}
            text={answered ? (answered.customText ?? "") : customText}
            onToggle={() => toggle(CUSTOM_OPTION_ID)}
            onTextChange={setCustomText}
          />
        )}
      </div>

      {!answered && (
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-[11px] text-[var(--faint)]">
            {multi ? "Select one or more" : "Select one"}
          </span>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="cursor-pointer rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-35 disabled:hover:opacity-35"
          >
            Confirm
          </button>
        </div>
      )}
    </div>
  );
}

/** Shared border/fill/dim treatment for an option card, whichever layout
 * (`layout`) its own content needs inside. */
function rowClass(checked: boolean, disabled: boolean, dimmed: boolean, layout: string): string {
  return [
    "relative rounded-lg border p-2.5 transition-colors duration-150",
    layout,
    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--accent)]/50",
    disabled ? "cursor-default" : "cursor-pointer",
    checked
      ? "border-[var(--accent)]/50 bg-[var(--accent)]/10"
      : `border-[var(--border)] bg-[var(--card)] ${disabled ? "" : "hover:bg-[var(--hover)]"}`,
    dimmed ? "opacity-40" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function OptionRow({
  groupName,
  option,
  multi,
  checked,
  disabled,
  dimmed,
  onChange,
}: {
  groupName: string;
  option: DecisionOption;
  multi: boolean;
  checked: boolean;
  disabled: boolean;
  dimmed: boolean;
  onChange: () => void;
}) {
  return (
    <label className={rowClass(checked, disabled, dimmed, "flex items-start gap-2.5")}>
      <input
        type={multi ? "checkbox" : "radio"}
        name={multi ? undefined : groupName}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="sr-only"
      />
      <Indicator multi={multi} checked={checked} />
      <span className="flex min-w-0 flex-col gap-0.5 pt-px">
        <span className="text-xs leading-5 break-words text-[var(--ink)]">{option.label}</span>
        {option.description && (
          <span className="text-[11px] leading-5 break-words text-[var(--faint)]">
            {option.description}
          </span>
        )}
      </span>
    </label>
  );
}

function CustomOptionRow({
  groupName,
  multi,
  checked,
  disabled,
  dimmed,
  text,
  onToggle,
  onTextChange,
}: {
  groupName: string;
  multi: boolean;
  checked: boolean;
  disabled: boolean;
  dimmed: boolean;
  text: string;
  onToggle: () => void;
  onTextChange: (text: string) => void;
}) {
  return (
    <div className={rowClass(checked, disabled, dimmed, "flex flex-col")}>
      <label className="flex cursor-pointer items-center gap-2.5">
        <input
          type={multi ? "checkbox" : "radio"}
          name={multi ? undefined : groupName}
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="sr-only"
        />
        <Indicator multi={multi} checked={checked} />
        <span className="text-xs text-[var(--ink)]">Something else…</span>
      </label>
      {checked &&
        (disabled ? (
          <div className="mt-1.5 ml-[26px] rounded-md bg-[rgba(0,0,0,0.15)] px-2 py-1.5 text-xs whitespace-pre-wrap text-[var(--muted)]">
            {text}
          </div>
        ) : (
          <input
            autoFocus
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="Type your own answer…"
            className="mt-1.5 ml-[26px] rounded-md border border-[var(--border)] bg-[rgba(0,0,0,0.15)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
          />
        ))}
    </div>
  );
}

function Indicator({ multi, checked }: { multi: boolean; checked: boolean }) {
  if (multi) {
    return (
      <span
        className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 ${
          checked ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--border)] bg-transparent"
        }`}
      >
        {checked && <Check size={11} strokeWidth={3} className="check-pop text-[#0c0c0e]" />}
      </span>
    );
  }
  return (
    <span
      className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
        checked ? "border-[var(--accent)]" : "border-[var(--border)]"
      }`}
    >
      {checked && <span className="check-pop h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />}
    </span>
  );
}
