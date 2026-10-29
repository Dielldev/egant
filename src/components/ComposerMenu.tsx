import { useEffect, useRef } from "react";
import type { CommandItem } from "../lib/composerMenu";
import type { InstalledSkill } from "../lib/types";
import { FileIcon } from "./FileIcon";
import { SkillLogo } from "./LibraryItemLogo";

export type MenuItem =
  | { kind: "skill"; skill: InstalledSkill }
  | { kind: "command"; command: CommandItem }
  | { kind: "file"; path: string };

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
        const key =
          item.kind === "skill"
            ? `skill:/${item.skill.id}`
            : item.kind === "command"
              ? `cmd:/${item.command.name}`
              : item.path;

        const showSkillHeader = item.kind === "skill" && (i === 0 || items[i - 1]?.kind !== "skill");
        const showCmdHeader = item.kind === "command" && (i === 0 || items[i - 1]?.kind !== "command");

        return (
          <div key={key}>
            {showSkillHeader && (
              <div className="flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)] tracking-wide uppercase">
                <span>Skills</span>
                <span className="text-[10px] text-[var(--faint)] font-normal normal-case">
                  select a skill to apply
                </span>
              </div>
            )}
            {showCmdHeader && (
              <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-[10px] font-semibold text-[var(--faint)] tracking-wide uppercase border-t border-[var(--border)] mt-1">
                <span>Commands</span>
              </div>
            )}
            <div
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
              {item.kind === "skill" ? (
                <SkillRow skill={item.skill} />
              ) : item.kind === "command" ? (
                <CommandRow command={item.command} />
              ) : (
                <FileRow path={item.path} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SkillRow({ skill }: { skill: InstalledSkill }) {
  const logo = (
    <SkillLogo source={skill.source} name={skill.name} agents={skill.agents} size={15} />
  );
  return (
    <>
      {logo && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--accent)]">
          {logo}
        </span>
      )}
      <span className="shrink-0 whitespace-nowrap font-medium text-[var(--ink)]">
        /{skill.id}
      </span>
      <span className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider bg-[var(--accent)]/10 border border-[var(--accent)]/25 text-[var(--accent)]">
        skill
      </span>
      {skill.description && (
        <span className="min-w-0 truncate text-[var(--muted)]">{skill.description}</span>
      )}
    </>
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
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
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
