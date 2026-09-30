// Claude's plan usage (the 5-hour and weekly limits), as the Mac reports it.
// One copy for every place that shows it — the Usage page and the strip above
// a chat's composer — fetched no more than every half minute, since each
// fetch is a round trip through the Mac to Anthropic.

import { create } from "zustand";
import type { ClaudeUsage } from "@egant/lib/types";
import { api } from "./api";

const FRESH_MS = 30_000;

interface UsageStore {
  /** `null` until known, or when Claude isn't signed in on the Mac. */
  claude: ClaudeUsage | null;
  /** A fetch has come back at least once (so `null` above means "signed out"). */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  fetchedAt: number;
  load: (force?: boolean) => Promise<void>;
}

export const useUsage = create<UsageStore>()((set, get) => ({
  claude: null,
  loaded: false,
  loading: false,
  error: null,
  fetchedAt: 0,
  load: async (force = false) => {
    const { loading, fetchedAt } = get();
    if (loading || (!force && Date.now() - fetchedAt < FRESH_MS)) return;
    set({ loading: true });
    try {
      const reply = await api.usage();
      set({ claude: reply.claude, loaded: true, error: null, fetchedAt: Date.now() });
    } catch (error) {
      // Keep whatever was last known; say what went wrong beside it.
      set({ error: error instanceof Error ? error.message : "Usage could not be loaded." });
    } finally {
      set({ loading: false });
    }
  },
}));
