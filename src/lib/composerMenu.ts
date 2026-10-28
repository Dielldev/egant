// What the composer's `/` and `@` menus offer, and when they open.

import type { SlashCommand } from "./types";

/** The word at the caret that opened a menu: a `/command` that starts the
 * message, or an `@mention` anywhere. `start`..`end` is the whole word —
 * what a pick replaces — and `query` the part of it before the caret. */
export interface MenuTrigger {
  kind: "command" | "mention";
  start: number;
  end: number;
  query: string;
}

const SPACE = /\s/;

/** The menu the caret is in, if any. A `/` counts at the start of the message,
 * at the start of any line, or at the start of any word. An `@` counts at the
 * start of any word. */
export function findTrigger(text: string, caret: number): MenuTrigger | null {
  // Check `/` command or skill trigger
  let cmdStart = caret;
  while (cmdStart > 0 && !SPACE.test(text[cmdStart - 1]!)) cmdStart--;
  if (cmdStart < text.length && text[cmdStart] === "/" && caret > cmdStart) {
    let end = caret;
    while (end < text.length && !SPACE.test(text[end]!)) end++;
    return { kind: "command", start: cmdStart, end, query: text.slice(cmdStart + 1, caret) };
  }

  // Check `@` file mention
  let start = caret;
  while (start > 0 && !SPACE.test(text[start - 1]!)) start--;
  if (text[start] !== "@" || start >= caret) return null;
  let end = caret;
  while (end < text.length && !SPACE.test(text[end]!)) end++;
  return { kind: "mention", start, end, query: text.slice(start + 1, caret) };
}

/** What picking a command does: put it in the box to be sent (with whatever
 * it takes after it), or something egant does itself. */
export type CommandRun = "insert" | "model" | "mode" | "clear" | "skills";

export interface CommandItem {
  name: string;
  description: string | null;
  hint: string | null;
  run: CommandRun;
}

/** egant's own commands, ahead of the agent's. `/clear` starts a new chat
 * rather than wiping this one — the conversation stays in the sidebar —
 * and `/model` and `/mode` open the pickers the footer already has. */
const OWN_COMMANDS: (CommandItem & { claudeOnly?: boolean })[] = [
  {
    name: "skills",
    description: "Browse and manage skills in the Library",
    hint: null,
    run: "skills",
  },
  {
    name: "compact",
    description: "Summarize the conversation so far to free up context",
    hint: "[what to keep]",
    run: "insert",
    claudeOnly: true,
  },
  { name: "model", description: "Switch this chat's model", hint: null, run: "model" },
  {
    name: "mode",
    description: "Change how much the agent may do without asking",
    hint: null,
    run: "mode",
  },
  {
    name: "clear",
    description: "Start a new chat — this one stays in the sidebar",
    hint: null,
    run: "clear",
  },
];

/** Every command the `/` menu offers a session: egant's own, then the ones
 * its agent listed (Claude's — the other agents list none), less any egant
 * answers itself. */
export function commandItems(agent: string, listed: SlashCommand[] | undefined): CommandItem[] {
  const own = OWN_COMMANDS.filter((command) => !command.claudeOnly || agent === "claude").map(
    ({ claudeOnly: _, ...command }) => command,
  );
  const taken = new Set(OWN_COMMANDS.map((command) => command.name));
  const theirs = (listed ?? [])
    .filter((command) => !taken.has(command.name))
    .map(
      (command): CommandItem => ({
        name: command.name,
        description: command.description,
        hint: command.argumentHint,
        run: "insert",
      }),
    );
  return [...own, ...theirs];
}

/** How a picked file goes into the message: `@path`, quoted when the path
 * has a space in it, the way Claude Code writes one. */
export function mention(path: string): string {
  return SPACE.test(path) ? `@"${path}"` : `@${path}`;
}
