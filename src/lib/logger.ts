// Console-only structured logging for the egant frontend.
//
// Every message carries a scope (`ipc`, `store`, `session-event`, …) so a
// DevTools filter like `[egant][ipc]` isolates one stream. Levels follow the
// backend (`RUST_LOG`): lifecycle at info, protocol details at debug.
//
// Debug output is off by default. Enable it for one window with
// `localStorage["egant.logLevel"] = "debug"` (or `VITE_LOG_LEVEL=debug`
// at build time), then reload. Nothing here leaves the machine — it is
// plain `console.*`, no file, no network.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const KEY = "egant.logLevel";

function parseLevel(raw: string | null | undefined): LogLevel | null {
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return null;
}

function storedLevel(): LogLevel | null {
  try {
    return parseLevel(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function envLevel(): LogLevel | null {
  try {
    return parseLevel(import.meta.env.VITE_LOG_LEVEL as string | undefined);
  } catch {
    return null;
  }
}

/** Active level: explicit localStorage override, else build env, else info. */
export function getLogLevel(): LogLevel {
  return storedLevel() ?? envLevel() ?? "info";
}

/** Persist a level override for this window (`null` clears it). Reload to apply. */
export function setLogLevel(level: LogLevel | null): void {
  try {
    if (level == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, level);
  } catch {
    // Unavailable storage: the window keeps the default level.
  }
}

function enabled(level: LogLevel): boolean {
  return ORDER[level] >= ORDER[getLogLevel()];
}

function prefix(scope: string): string {
  return `[egant][${scope}]`;
}

function messageText(message: unknown): string {
  return message instanceof Error ? message.message : String(message);
}

/** One-line preview of user text: newlines collapsed, capped, with length. */
export function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return `${flat} (${text.length} chars)`;
  return `${flat.slice(0, max)}… (${text.length} chars)`;
}

export const log = {
  debug(scope: string, message: string, ...args: unknown[]): void {
    if (enabled("debug")) console.debug(prefix(scope), message, ...args);
  },
  info(scope: string, message: string, ...args: unknown[]): void {
    if (enabled("info")) console.info(prefix(scope), message, ...args);
  },
  warn(scope: string, message: string, ...args: unknown[]): void {
    if (enabled("warn")) console.warn(prefix(scope), message, ...args);
  },
  error(scope: string, message: unknown, ...args: unknown[]): void {
    if (enabled("error")) console.error(prefix(scope), messageText(message), ...args);
  },
};
