// Session notifications: the sound and the desktop banner behind
// Settings > Notifications.
//
// The sounds are Cuelume's — synthesized in Web Audio, so there is no audio
// file to ship. Each event takes the cue Cuelume's own guidance gives its job:
//
//   completed → `success`    an agent finished its task
//   input     → `attention`  blocked until the user answers
//   errors    → `error`      a model, tool or connection failure
//
// One cue when a run stops or stalls — never per token or per tool call, which
// fire in bursts and wear a sound out.
//
// All of it is for when the user is *away*: nothing sounds or shows while the
// egant window is the one they are using — the result is already in front of
// them. (The Settings previews are the exception; they answer an explicit click.)

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { play, themes } from "cuelume";
import type { ThemeName } from "cuelume";
import { log } from "./logger";
import { ASK_USER_QUESTION, EXIT_PLAN_MODE } from "./transcript";
import type { HarnessEvent, TranscriptState } from "./types";

/** The three things a session can tell the user. The names double as the
 * Settings toggles' storage keys (see `NOTIFY_KEYS`). */
export type NotifyKind = "completed" | "input" | "errors";

/** localStorage keys behind Settings > Notifications. The toggles write them
 * as JSON via `usePersistentState`; everything here reads them fresh per event,
 * so a change in Settings applies to the very next notification. */
export const NOTIFY_KEYS = {
  sounds: "egant.notify.sounds",
  completed: "egant.notify.completed",
  input: "egant.notify.input",
  errors: "egant.notify.errors",
  desktop: "egant.notify.desktop",
  theme: "egant.notify.theme",
} as const;

/** Cuelume's finished materials. `default` is warm and calm enough for all-day
 * use, which is what an agent pinging in the corner of your day should be. */
export const SOUND_THEMES: readonly ThemeName[] = themes;
export const DEFAULT_SOUND_THEME: ThemeName = "default";

const CUES = {
  completed: "success",
  input: "attention",
  errors: "error",
} as const satisfies Record<NotifyKind, string>;

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "boolean" ? parsed : fallback;
  } catch {
    // Corrupt or unavailable storage: fall through to the toggle's default.
    return fallback;
  }
}

export function readSoundTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(NOTIFY_KEYS.theme);
    const parsed: unknown = raw == null ? null : JSON.parse(raw);
    const known = SOUND_THEMES.find((theme) => theme === parsed);
    if (known) return known;
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  return DEFAULT_SOUND_THEME;
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/** Plays the cue for `kind` in the saved theme (or `theme`). Ignores
 * the on/off toggles: this is what the Settings previews call, and an explicit
 * click on Preview should always be heard. */
export function playCue(kind: NotifyKind, theme: ThemeName = readSoundTheme()): void {
  play(CUES[kind], { theme });
}

let unlockInstalled = false;

/** Readies Web Audio on the first real click or keypress. Cuelume creates its
 * `AudioContext` on the first cue, and WKWebView only lets a context start
 * inside a user gesture — a first cue that arrives from a `session-event`
 * (no gesture) would stay silent until the user happened to click something
 * that plays. Priming here, in a gesture, makes the first ping audible. The
 * cue is played at a volume no one can hear. Call once, at startup. */
export function installSoundUnlock(): void {
  if (unlockInstalled) return;
  unlockInstalled = true;
  const events = ["pointerdown", "keydown"] as const;
  const unlock = (): void => {
    // A press that isn't a real activation yet (Esc in Chromium, say) can't
    // start audio either — keep waiting for one that is.
    if (navigator.userActivation?.hasBeenActive === false) return;
    for (const name of events) window.removeEventListener(name, unlock, true);
    play("tap", { volume: 0.0001 });
  };
  for (const name of events) window.addEventListener(name, unlock, true);
}

// ---------------------------------------------------------------------------
// Desktop banner
// ---------------------------------------------------------------------------

let bannerPermitted = false;

/** Shows a system banner. Resolves `false` when the OS permission is missing.
 * On desktop the plugin reports permission as always granted and hands the
 * banner to the OS, so a banner the OS then suppresses (Focus mode, egant
 * switched off in System Settings) is silent — the Settings test button says
 * so rather than pretending it can tell. */
export async function sendBanner(title: string, body: string): Promise<boolean> {
  if (!bannerPermitted) {
    bannerPermitted =
      (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (!bannerPermitted) {
      log.warn("notify", "desktop notifications are not permitted");
      return false;
    }
  }
  sendNotification({ title, body });
  return true;
}

/** Whether the egant *window* has focus — the test for "is the user using
 * egant right now". Asked of the window, not the page: with the Browser
 * panel's own webview focused the page reads as blurred while the user is
 * plainly still in egant. */
async function windowFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    // Not running under Tauri (a plain browser tab): the page is all there is.
    return document.hasFocus();
  }
}

// ---------------------------------------------------------------------------
// Turning session events into notifications
// ---------------------------------------------------------------------------

export interface SessionNotice {
  kind: NotifyKind;
  body: string;
}

const BODY_MAX = 140;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > BODY_MAX ? `${flat.slice(0, BODY_MAX - 1)}…` : flat;
}

/** What, if anything, `event` should tell the user. `before` and `after` are
 * the transcript either side of folding it in.
 *
 * Only two signals mean a run failed. Raw `error` events do not: Claude's CLI
 * reports every stderr line and malformed frame that way — warnings included —
 * and a ping per warning would train the user to ignore it. A failed run always
 * ends in `turn_ended { is_error }`; a dead process ends in `exited`. */
export function noticeFor(
  event: HarnessEvent,
  before: TranscriptState,
  after: TranscriptState,
): SessionNotice | null {
  switch (event.type) {
    case "turn_ended": {
      if (event.is_error) {
        return { kind: "errors", body: oneLine(event.result ?? "The run failed.") };
      }
      // A turn that ends by putting a question to the user is waiting on them,
      // not done — the cue that says "answer me" fits, "success" would lie.
      const last = after.entries[after.entries.length - 1];
      if (last?.kind === "agent_request" && last.response === null) {
        return { kind: "input", body: "Waiting for your answer." };
      }
      return { kind: "completed", body: "Finished — ready for your next message." };
    }
    case "permission_request":
      // Several requests can pile up behind one stall: ping for the first.
      if ((before.pendingList ?? []).length > 0) return null;
      if (event.tool_name === ASK_USER_QUESTION) {
        return { kind: "input", body: "Has a question for you." };
      }
      if (event.tool_name === EXIT_PLAN_MODE) {
        return { kind: "input", body: "Plan ready for your review." };
      }
      return { kind: "input", body: `Needs your approval: ${event.tool_name}` };
    case "exited":
      // Closing a session or switching its model never reaches here — the
      // backend drops the listener first — so an exit is the agent dying.
      return { kind: "errors", body: "The agent exited unexpectedly." };
    default:
      return null;
  }
}

/** How long after the user presses Stop the next turn end still counts as the
 * stop. Codex and opencode settle it at once as an `is_error` "Interrupted."
 * turn; Claude answers a beat later. Neither is news to the person who asked. */
const INTERRUPT_WINDOW_MS = 20_000;
const interruptedAt = new Map<number, number>();

/** Records that the user just stopped `sessionId`'s run, so the turn end it
 * produces stays quiet. */
export function noteInterrupt(sessionId: number): void {
  interruptedAt.set(sessionId, Date.now());
}

function takeInterrupt(sessionId: number): boolean {
  const at = interruptedAt.get(sessionId);
  interruptedAt.delete(sessionId);
  return at !== undefined && Date.now() - at < INTERRUPT_WINDOW_MS;
}

/** Plays and shows whatever `event` calls for, honouring Settings and staying
 * quiet while the egant window is focused. Never throws and never waits on the
 * caller: a notification must not be able to break the fold of the event that
 * caused it. */
export function notifySession(
  sessionId: number,
  event: HarnessEvent,
  before: TranscriptState,
  after: TranscriptState,
  title: string,
): void {
  if (event.type === "turn_ended" && takeInterrupt(sessionId)) return;
  const notice = noticeFor(event, before, after);
  if (!notice || !readBool(NOTIFY_KEYS[notice.kind], true)) return;
  void deliver(notice, title).catch((error: unknown) => {
    log.warn("notify", `notification failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function deliver(notice: SessionNotice, title: string): Promise<void> {
  // Someone using egant sees the run finish, stall or fail for themselves; a
  // ping on top would only be noise. It is for the person who looked away.
  if (await windowFocused()) return;
  if (readBool(NOTIFY_KEYS.sounds, true)) playCue(notice.kind);
  if (readBool(NOTIFY_KEYS.desktop, true)) {
    await sendBanner(title.trim() || "egant", notice.body);
  }
}
