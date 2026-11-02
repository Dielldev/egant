/** Prompt text typed into the composer but not sent yet, kept per place it
 * was typed.
 *
 * The composer sits inside the transcript, so switching conversations can
 * unmount it — and a new chat, or a session whose transcript is still
 * crossing the IPC boundary, renders the launch composer instead. Either way
 * the box starts empty and the half-written prompt would be gone. It waits
 * here instead, under the conversation it belongs to, until that composer
 * comes back. */
const drafts = new Map<string, string>();

/** The draft's key: one per session, plus one for the launch screen, where a
 * conversation does not exist yet. */
export function composerDraftKey(sessionId: number | null): string {
  return sessionId == null ? "launch" : `session:${sessionId}`;
}

export function readComposerDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/** Keeps `text` for `key` — an empty box forgets its draft rather than
 * holding an empty string. */
export function writeComposerDraft(key: string, text: string): void {
  if (text.length === 0) drafts.delete(key);
  else drafts.set(key, text);
}

/** Forgets `key`'s draft — after a send, the prompt has left the box for
 * good. */
export function clearComposerDraft(key: string): void {
  drafts.delete(key);
}
