import { useEffect, useRef } from "react";
import type { CommandItem } from "../lib/composerMenu";
import { FileIcon } from "./FileIcon";

export type MenuItem = { kind: "command"; command: CommandItem } | { kind: "file"; path: string };

/** The list the composer's `/` and `@` open above it. Keyboard-driven from the
 * text box — arrows move, Enter or Tab picks, Esc closes — so this only
 * draws the rows and takes the mouse. A row is picked on mouse-down, before
 * the box would lose focus to it. */
export function ComposerMenu({
  items,
  index,
  status,
  onHover,
  onPick,
}: {
  items: MenuItem[];
  index: number;
  /** Said instead of rows while there are none: loading, or no match. */
  status: string | null;
  onHover: (index: number) => void;
  onPick: (item: MenuItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row in view as the arrows walk past the edge.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      ref={listRef}
      role="listbox"
      className="menu menu-pop-up absolute right-0 bottom-full left-0 z-40 mb-2 max-h-[300px] overflow-y-auto rounded-xl p-1 text-[13px]"
    >
      {items.length === 0 && status && (
        <div className="px-2.5 py-1.5 text-[var(--faint)]">{status}</div>
      )}
      {items.map((item, i) => {
        const active = i === index;
        const key = item.kind === "command" ? `/${item.command.name}` : item.path;
        return (
          <div
            key={key}
            data-row={i}
            role="option"
            aria-selected={active}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
            className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 ${
              active ? "bg-[var(--hover)]" : ""
            }`}
          >
            {item.kind === "command" ? <CommandRow command={item.command} /> : <FileRow path={item.path} />}
          </div>
        );
      })}
    </div>
  );
}

function CommandRow({ command }: { command: CommandItem }) {
  return (
    <>
      <span className="shrink-0 whitespace-nowrap text-[var(--ink)]">/{command.name}</span>
      {command.hint && (
        <span className="shrink-0 whitespace-nowrap text-[var(--faint)]">{command.hint}</span>
      )}
      {command.description && (
        <span className="min-w-0 truncate text-[var(--muted)]">{command.description}</span>
      )}
    </>
  );
}

function FileRow({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dir = slash > 0 ? path.slice(0, slash) : "";
  return (
    <>
      <FileIcon name={name} size={14} />
      <span className="shrink-0 whitespace-nowrap text-[var(--ink)]">{name}</span>
      {dir && <span className="min-w-0 truncate text-[var(--faint)]">{dir}</span>}
    </>
  );
}
