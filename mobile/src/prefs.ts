// What this phone remembers about itself: how it looks, and what a new chat
// starts with. All of it stays on the phone — the Mac's own choices (its
// default agent, its wallpaper) are only ever read, as fallbacks.

import { create } from "zustand";
import { DARK_THEMES, LIGHT_THEMES } from "@egant/lib/themes";
import aurora from "./assets/backgrounds/aurora.webp";
import dune from "./assets/backgrounds/dune.webp";
import dusk from "./assets/backgrounds/dusk.webp";
import nocturne from "./assets/backgrounds/nocturne.webp";

export type Scheme = "system" | "dark" | "light";

/** The pictures that come with the app, for a Mac with no wallpaper set (or
 * a phone that would rather have its own). */
export const BUILT_IN_BACKGROUNDS = [
  { id: "dusk", label: "Dusk", src: dusk },
  { id: "nocturne", label: "Nocturne", src: nocturne },
  { id: "aurora", label: "Aurora", src: aurora },
  { id: "dune", label: "Dune", src: dune },
] as const;

/** `mac` is whatever the desktop shows, `photo` one picked on this phone. */
export type Background = "mac" | "photo" | "none" | (typeof BUILT_IN_BACKGROUNDS)[number]["id"];

export interface Prefs {
  scheme: Scheme;
  darkTheme: string;
  lightTheme: string;
  /** `default` keeps the palette's own accent, otherwise a hex colour. */
  accent: string;
  background: Background;
  /** How far the background is darkened under the greeting, 0–0.8. */
  dim: number;
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
const PHOTO_KEY = "egant.phone.photo";

const DEFAULTS: Prefs = {
  scheme: "system",
  darkTheme: "zeron-dark",
  lightTheme: "zeron-light",
  accent: "default",
  background: "mac",
  dim: 0.25,
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
    return typeof parsed === "object" && parsed !== null ? { ...DEFAULTS, ...parsed } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function loadPhoto(): string | null {
  try {
    return localStorage.getItem(PHOTO_KEY);
  } catch {
    return null;
  }
}

interface PrefsStore extends Prefs {
  /** The picked photo as a data URL, kept apart from the rest (it is large). */
  photo: string | null;
  set: (patch: Partial<Prefs>) => void;
  /** Keeps a picked photo, scaled down to what a phone screen can show. */
  setPhoto: (file: File) => Promise<void>;
}

export const usePrefs = create<PrefsStore>()((set, get) => ({
  ...load(),
  photo: loadPhoto(),
  set: (patch) => {
    set(patch);
    const { photo: _photo, set: _set, setPhoto: _setPhoto, ...prefs } = get();
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Unavailable storage: the choice lasts for this visit.
    }
  },
  setPhoto: async (file) => {
    const photo = await downscale(file, 1600);
    try {
      localStorage.setItem(PHOTO_KEY, photo);
    } catch {
      // Too large for storage even scaled: it shows until the app reloads.
    }
    set({ photo });
    get().set({ background: "photo" });
  },
}));

/** A photo from the camera roll is 12 megapixels; a phone background needs a
 * fraction of that, and local storage holds only a few megabytes. */
async function downscale(file: File, longest: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, longest / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const light = window.matchMedia("(prefers-color-scheme: light)");

export function resolvedScheme(scheme: Scheme): "light" | "dark" {
  if (scheme !== "system") return scheme;
  return light.matches ? "light" : "dark";
}

/** Paints the chosen palette onto the page — the desktop's own palettes, from
 * its stylesheet — and tells the phone's status bar what colour it sits on. */
export function applyTheme(prefs: Prefs): void {
  const scheme = resolvedScheme(prefs.scheme);
  const palette = scheme === "light" ? prefs.lightTheme : prefs.darkTheme;
  const html = document.documentElement;
  html.dataset.theme = scheme;
  // The desktop's default dark palette is the stylesheet's root, not a rule.
  if (palette === "zeron-dark") delete html.dataset.palette;
  else html.dataset.palette = palette;
  if (prefs.accent === "default") html.style.removeProperty("--accent");
  else html.style.setProperty("--accent", prefs.accent);
  const option = [...DARK_THEMES, ...LIGHT_THEMES].find((theme) => theme.value === palette);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", option?.swatch[0] ?? (scheme === "light" ? "#f2f2f5" : "#0d0d0d"));
}

/** The palette's own accent, where the phone has not picked one. */
export function accentOf(prefs: Prefs): string {
  if (prefs.accent !== "default") return prefs.accent;
  const scheme = resolvedScheme(prefs.scheme);
  const palette = scheme === "light" ? prefs.lightTheme : prefs.darkTheme;
  return [...DARK_THEMES, ...LIGHT_THEMES].find((theme) => theme.value === palette)?.swatch[1] ?? "#8e7cf6";
}

light.addEventListener("change", () => applyTheme(usePrefs.getState()));
usePrefs.subscribe((prefs, previous) => {
  if (
    prefs.scheme !== previous.scheme ||
    prefs.darkTheme !== previous.darkTheme ||
    prefs.lightTheme !== previous.lightTheme ||
    prefs.accent !== previous.accent
  ) {
    applyTheme(prefs);
  }
});
