import { ArrowUp, Plus, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePrefs } from "../prefs";

export interface ComposerHandle {
  focus: () => void;
}

/** One thing the + opens: a choice that rides along with the message (where
 * it runs, what the agent may do). Without `onClick` it only tells. */
export interface ComposerMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  value?: string;
  tone?: "warn";
  onClick?: () => void;
}

/** The message box, on both screens: the text on top, and under it a + that
 * opens the choices riding along and the send disc — which turns into Stop
 * while the agent works. */
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
    menu?: ComposerMenuItem[];
  }
>(function Composer(
  { value, onChange, onSubmit, placeholder, busy, onStop, disabled, sending, menu },
  ref,
) {
  const enterSends = usePrefs((s) => s.enterSends);
  const area = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
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
  const items = menu ?? [];
  const warn = items.some((item) => item.tone === "warn");

  return (
    <div className="relative">
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="pop-in absolute bottom-full left-1 z-40 mb-2 min-w-[260px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[22px] border border-[var(--hairline)] bg-[var(--raised)] shadow-[0_16px_48px_rgba(0,0,0,0.35)]"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={!item.onClick}
                onClick={() => {
                  setOpen(false);
                  item.onClick?.();
                }}
                className="flex min-h-[52px] w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-2.5 text-left last:border-b-0 active:bg-[var(--hover)]"
              >
                <span
                  className={`flex w-5 shrink-0 items-center justify-center ${
                    item.tone === "warn" ? "text-amber-500 dark:text-amber-300" : "text-[var(--muted)]"
                  }`}
                >
                  {item.icon}
                </span>
                <span className="text-[16px] text-[var(--ink)]">{item.label}</span>
                {item.value && (
                  <span className="ml-auto min-w-0 truncate pl-3 text-[15px] text-[var(--muted)]">
                    {item.value}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="composer rounded-[26px] px-2 pt-1 pb-2">
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
          className="block max-h-[168px] min-h-[48px] w-full resize-none bg-transparent px-2.5 pt-3 pb-1 text-[17px] leading-6 tracking-[-0.011em] text-[var(--ink)] outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
        />
        <div className="flex items-center gap-2 pt-1">
          {items.length > 0 && (
            <button
              type="button"
              aria-label="More"
              aria-expanded={open}
              onClick={() => setOpen((was) => !was)}
              className="press relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--bubble)] text-[var(--ink)]"
            >
              <Plus
                size={20}
                strokeWidth={2.2}
                className="transition-transform duration-300 ease-[var(--ease-ios)]"
                style={{ transform: open ? "rotate(45deg)" : "none" }}
              />
              {warn && (
                <span className="absolute top-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[var(--stage)] bg-amber-400" />
              )}
            </button>
          )}
          <div className="min-w-0 flex-1" />
          {busy && !hasText ? (
            <button
              key="stop"
              type="button"
              aria-label="Stop the agent"
              onClick={onStop}
              className="press swap-in flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ink)] text-[var(--stage)]"
            >
              <Square size={13} strokeWidth={2} fill="currentColor" />
            </button>
          ) : (
            <button
              key={canSend ? "send-on" : "send-off"}
              type="button"
              aria-label="Send"
              aria-disabled={!canSend}
              onClick={submit}
              className={`press flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                canSend
                  ? "swap-in bg-[var(--ink)] text-[var(--stage)]"
                  : "bg-[var(--bubble)] text-[var(--faint)]"
              }`}
            >
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
