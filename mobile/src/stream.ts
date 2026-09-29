// The live connection to the Mac: one EventSource, resumed from wherever the
// page left off.
//
// Phones drop connections constantly — the screen locks, the app goes to the
// background, the network changes — so a dropped stream is the normal case,
// not an error. On any drop this closes it, asks the Mac whether it is there
// (and still knows this phone), and reopens from the last position applied;
// the Mac replays what was missed, or says to resync when that is too much.

import { useMobile } from "./store";
import type { StreamMessage } from "./store";

let source: EventSource | null = null;
let retry: number | undefined;
let attempt = 0;
let running = false;

export function startStream(): void {
  running = true;
  attempt = 0;
  open();
}

export function stopStream(): void {
  running = false;
  window.clearTimeout(retry);
  close();
}

function open(): void {
  close();
  const { seq, epoch, setConnection } = useMobile.getState();
  const stream = new EventSource(
    `/api/v1/events?since=${seq}&epoch=${encodeURIComponent(epoch)}`,
  );
  source = stream;
  setConnection("connecting");
  stream.onopen = () => {
    attempt = 0;
    useMobile.getState().setConnection("live");
  };
  stream.onmessage = (event) => {
    try {
      useMobile.getState().receive(JSON.parse(event.data as string) as StreamMessage);
    } catch {
      // A frame this page can't read is skipped; the next resync covers it.
    }
  };
  stream.onerror = () => {
    // The browser would retry on its own, from the position in the URL it
    // started with. Retrying here resumes from where the page actually is.
    if (source !== stream) return;
    close();
    useMobile.getState().setConnection("down");
    schedule();
  };
}

function close(): void {
  if (!source) return;
  source.onopen = null;
  source.onmessage = null;
  source.onerror = null;
  source.close();
  source = null;
}

function schedule(): void {
  if (!running) return;
  window.clearTimeout(retry);
  const delay = Math.min(15_000, 500 * 2 ** attempt);
  attempt += 1;
  retry = window.setTimeout(() => void reconnect(), delay);
}

/** Reopens the stream if the Mac answers and still knows this phone. */
export async function reconnect(): Promise<void> {
  if (!running) return;
  window.clearTimeout(retry);
  const verdict = await useMobile.getState().probe();
  if (!running) return;
  if (verdict === "ok") open();
  else if (verdict === "unreachable") schedule();
  else stopStream();
}

// Back from the background (or the lock screen, or a dead network): don't
// wait out the backoff — the user is looking at the screen now.
function wake(): void {
  if (!running || document.hidden) return;
  if (useMobile.getState().connection === "live" && source?.readyState === EventSource.OPEN) {
    return;
  }
  attempt = 0;
  void reconnect();
}

document.addEventListener("visibilitychange", wake);
window.addEventListener("online", wake);
window.addEventListener("pageshow", wake);
