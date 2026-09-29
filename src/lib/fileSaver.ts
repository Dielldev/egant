import { api } from "./api";

/** Saving is where an editor and the agent can trample each other, so every
 * save states which version of the file it was made from and lines up behind
 * any save of the same file already under way — the second one then starts
 * from the version the first one left, rather than from a stale one that would
 * read as a conflict with ourselves. */

/** The modification time each open file was last known to have: what it had
 * when read, then what our own last save left. */
const bases = new Map<string, number>();
const chains = new Map<string, Promise<unknown>>();

export function setBase(path: string, modifiedMs: number): void {
  bases.set(path, modifiedMs);
}

export function getBase(path: string): number {
  return bases.get(path) ?? 0;
}

export type SaveResult =
  | { ok: true }
  /** The file changed on disk since it was read — the agent, or another
   * program, got there first. Nothing was written. */
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; message: string };

/** Writes `text` to `path`. `force` skips the version check — "Overwrite". */
export function saveFile(path: string, text: string, force = false): Promise<SaveResult> {
  const previous = chains.get(path) ?? Promise.resolve();
  const run = previous.then(async (): Promise<SaveResult> => {
    try {
      // Read now, not when queued: an earlier save in the chain has moved it.
      const next = await api.writeFile(path, text, force ? null : (bases.get(path) ?? null));
      bases.set(path, next);
      return { ok: true };
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : String(problem);
      return message.startsWith("conflict:")
        ? { ok: false, conflict: true }
        : { ok: false, conflict: false, message };
    }
  });
  chains.set(path, run);
  return run;
}
