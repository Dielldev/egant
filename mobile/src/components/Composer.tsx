import { ArrowUp, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { ReactNode } from "react";
import { usePrefs } from "../prefs";

export interface ComposerHandle {
  focus: () => void;
}

/** The message box, on both screens: the text on top, and a row under it
 * with the choices that ride along (project, mode) on the left and the send
 * disc on the right — which turns into Stop while the agent works. */
export const Composer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
    busy?: boolean;
    onStop?: () => void;
    disabled?: boolean;
    /** Sending is already under way (a chat starting). */
    sending?: boolean;
    toolbar?: ReactNode;
  }
>(function Composer(
  { value, onChange, onSubmit, placeholder, busy, onStop, disabled, sending, toolbar },
  ref,
) {
  const enterSends = usePrefs((s) => s.enterSends);
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus() }), []);

  // Grows with the message, up to a handful of lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [value]);

  const hasText = value.trim().length > 0;
  const canSend = hasText && !disabled && !sending;
  const submit = () => {
    if (!canSend) return;
    onSubmit();
  };

  return (
    <div className="composer rounded-[28px] px-1.5 pt-1.5 pb-1.5">
      <textarea
        ref={area}
        value={value}
        rows={1}
        disabled={disabled}
        enterKeyHint={enterSends ? "send" : "enter"}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (enterSends && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="block max-h-[168px] min-h-[44px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[16px] leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
      />
      <div className="flex items-center gap-1.5 pt-1">
        <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {toolbar}
        </div>
        {busy && !hasText ? (
          <button
            type="button"
            aria-label="Stop the agent"
            onClick={onStop}
            className="press flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ink)] text-[var(--stage)]"
          >
            <Square size={13} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            aria-disabled={!canSend}
            onClick={submit}
            className={`press flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
              canSend
                ? "bg-[var(--ink)] text-[var(--stage)]"
                : "bg-[var(--bubble)] text-[var(--faint)]"
            }`}
          >
            <ArrowUp size={19} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
});

/** A choice riding along with the message: what it is, and a tap to change
 * it. */
export function ToolbarChip({
  icon,
  label,
  onClick,
  tone,
}: {
  icon?: ReactNode;
  label: ReactNode;
  onClick: () => void;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`press flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-[var(--hairline)] px-3 text-[13px] font-medium ${
        tone === "warn" ? "text-amber-500 dark:text-amber-300" : "text-[var(--muted)]"
      } active:bg-[var(--hover)]`}
    >
      {icon}
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
  );
}
