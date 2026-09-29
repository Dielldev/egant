// What this phone remembers about itself: light or dark, how chats read, and
// what a new chat starts with. All of it stays on the phone — the Mac's own
// choices (its default agent) are only ever read, as fallbacks.

import { create } from "zustand";

export type Scheme = "system" | "dark" | "light";

export interface Prefs {
  scheme: Scheme;
  showThinking: boolean;
  /** Return sends instead of starting a new line. */
  enterSends: boolean;
  /** Agent a new chat starts with; `null` follows the Mac's default. */
  agent: string | null;
  /** Model per agent for new chats; `""` or absent is the CLI's default. */
  models: Record<string, string>;
  /** Effort per agent for new chats. */
  variants: Record<string, string>;
  /** Permission mode a new chat starts in. */
  mode: string;
  /** Project a new chat runs in; `null` is the most recently used one. */
  project: number | null;
}

const PREFS_KEY = "egant.phone.prefs";

const DEFAULTS: Prefs = {
  scheme: "system",
  showThinking: true,
  enterSends: false,
  agent: null,
  models: {},
  variants: {},
  mode: "auto",
  project: null,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const prefs = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
      if (key in parsed) (prefs as Record<string, unknown>)[key] = parsed[key];
    }
    return prefs;
  } catch {
    return DEFAULTS;
  }
}

interface PrefsStore extends Prefs {
  set: (patch: Partial<Prefs>) => void;
}

export const usePrefs = create<PrefsStore>()((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    const { set: _set, ...prefs } = get();
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Unavailable storage: the choice lasts for this visit.
    }
  },
}));

const light = window.matchMedia("(prefers-color-scheme: light)");

export function resolvedScheme(scheme: Scheme): "light" | "dark" {
  if (scheme !== "system") return scheme;
  return light.matches ? "light" : "dark";
}

/** Black or white: the page's scheme (see `mobile.css`), and the colour the
 * phone's status bar sits on. */
export function applyTheme(prefs: Prefs): void {
  const scheme = resolvedScheme(prefs.scheme);
  const html = document.documentElement;
  html.dataset.theme = scheme;
  // The light scheme starts from the desktop's light palette; the dark one
  // is the stylesheet's root.
  if (scheme === "light") html.dataset.palette = "zeron-light";
  else delete html.dataset.palette;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", scheme === "light" ? "#ffffff" : "#000000");
}

light.addEventListener("change", () => applyTheme(usePrefs.getState()));
usePrefs.subscribe((prefs, previous) => {
  if (prefs.scheme !== previous.scheme) applyTheme(prefs);
});
