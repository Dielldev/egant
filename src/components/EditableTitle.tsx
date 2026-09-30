import { useEffect, useRef, useState } from "react";

/** A conversation's title that turns into a text field on double-click:
 * Enter or leaving the field saves, Escape gives up. Keys stay in the field
 * — a space or an Enter must not also reach the row or the window around it
 * (selecting the row, sending, interrupting). */
export function EditableTitle({
  title,
  onRename,
  className,
  inputClassName,
  hint,
}: {
  title: string;
  onRename: (title: string) => void;
  className?: string;
  inputClassName?: string;
  /** A tooltip for the resting title. Left out where something around it
   * already has one worth keeping. */
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.replace(/\s+/g, " ").trim();
    if (next && next !== title) onRename(next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={120}
        aria-label="Conversation title"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
        className={
          inputClassName ??
          "min-w-0 flex-1 rounded-md border border-[var(--accent)]/60 bg-[rgba(0,0,0,0.2)] px-1.5 py-0 text-[13px] text-[var(--ink)] outline-none"
        }
      />
    );
  }

  return (
    <span
      title={hint}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(title);
        setEditing(true);
      }}
      className={className}
    >
      {title}
    </span>
  );
}
