// Where a new chat can run — the project's folder or a worktree that already
// exists — and how far each is behind the main branch, as the Mac reads it
// from git. Kept per project; the reading is cheap, so it is asked for again
// whenever a project comes up, and the remote itself is only asked about
// (a fetch on the Mac) every few minutes.

import { create } from "zustand";
import { api } from "./api";
import type { Checkout, CheckoutList } from "./api";
import { usePrefs } from "./prefs";

const FETCH_EVERY_MS = 5 * 60_000;

interface CheckoutsStore {
  byProject: Record<number, CheckoutList | undefined>;
  loading: Record<number, boolean>;
  /** When each project last had the remote asked about. */
  fetchedAt: Record<number, number>;
  pulling: boolean;
  error: string | null;
  /** `fetch: true` also asks the remote, unless that was done lately (or
   * `force`, for the picker the user opened on purpose). */
  load: (projectId: number, options?: { fetch?: boolean; force?: boolean }) => Promise<void>;
  /** Fast-forwards the project's folder. Resolves to the error, if any. */
  pull: (projectId: number) => Promise<string | null>;
}

export const useCheckouts = create<CheckoutsStore>()((set, get) => ({
  byProject: {},
  loading: {},
  fetchedAt: {},
  pulling: false,
  error: null,
  load: async (projectId, { fetch = false, force = false } = {}) => {
    if (get().loading[projectId]) return;
    const askRemote = fetch && (force || Date.now() - (get().fetchedAt[projectId] ?? 0) > FETCH_EVERY_MS);
    set((state) => ({ loading: { ...state.loading, [projectId]: true } }));
    try {
      const list = await api.checkouts(projectId, askRemote);
      set((state) => ({
        byProject: { ...state.byProject, [projectId]: list },
        fetchedAt: askRemote ? { ...state.fetchedAt, [projectId]: Date.now() } : state.fetchedAt,
        error: null,
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Couldn't read the checkouts." });
    } finally {
      set((state) => ({ loading: { ...state.loading, [projectId]: false } }));
    }
  },
  pull: async (projectId) => {
    if (get().pulling) return null;
    set({ pulling: true });
    try {
      const list = await api.pull(projectId);
      set((state) => ({
        byProject: { ...state.byProject, [projectId]: list },
        fetchedAt: { ...state.fetchedAt, [projectId]: Date.now() },
      }));
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "The pull didn't go through.";
    } finally {
      set({ pulling: false });
    }
  },
}));

/** The checkout a new chat in this project will run in: the worktree the
 * phone picked while it still exists, else the project's own folder. */
export function chosenCheckout(projectId: number, list: CheckoutList | undefined): Checkout | null {
  const branch = usePrefs.getState().checkouts[String(projectId)];
  const checkouts = list?.checkouts ?? [];
  return (
    (branch ? checkouts.find((c) => c.kind === "worktree" && c.branch === branch) : undefined) ??
    checkouts.find((c) => c.kind === "project") ??
    null
  );
}

/** Remembers the pick for a project (`null` is the folder itself). */
export function chooseCheckout(projectId: number, branch: string | null): void {
  const next = { ...usePrefs.getState().checkouts };
  if (branch) next[String(projectId)] = branch;
  else delete next[String(projectId)];
  usePrefs.getState().set({ checkouts: next });
}
