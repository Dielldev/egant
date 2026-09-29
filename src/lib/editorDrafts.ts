import { create } from "zustand";

/** Edits that have not reached the disk yet, kept for as long as the app
 * lives.
 *
 * A file's editor is only mounted while its tab is in front, so switching to
 * the chat and back would otherwise throw away whatever Autosave was not on
 * hand to write. The text waits here instead, and the editor picks it up again
 * when the tab does. */
export interface Draft {
  /** The edited text. */
  text: string;
  /** The version of the file it was edited from, for the save to be checked
   * against. */
  baseModifiedMs: number;
}

const drafts = new Map<string, Draft>();

/** Which files have unsaved changes right now — a plain record, so the tab
 * strip can subscribe to it and mark them. */
export const useDirtyFiles = create<{ paths: Record<string, true> }>(() => ({ paths: {} }));

export function setFileDirty(path: string, dirty: boolean): void {
  const { paths } = useDirtyFiles.getState();
  if (!!paths[path] === dirty) return;
  const next = { ...paths };
  if (dirty) next[path] = true;
  else delete next[path];
  useDirtyFiles.setState({ paths: next });
}

export function isFileDirty(path: string): boolean {
  return !!useDirtyFiles.getState().paths[path];
}

/** Keeps unsaved text for `path` until its editor comes back. */
export function stashDraft(path: string, draft: Draft): void {
  drafts.set(path, draft);
  setFileDirty(path, true);
}

/** Unsaved text left behind by an earlier mount, if any. */
export function peekDraft(path: string): Draft | undefined {
  return drafts.get(path);
}

/** Forgets `path`'s draft and its unsaved mark — after a save, a reload from
 * disk, or a discard. */
export function dropDraft(path: string): void {
  drafts.delete(path);
  setFileDirty(path, false);
}
