// The phone's state: the session list, the transcripts it has opened, and
// where it is on the Mac's numbered event stream.
//
// Consistency is by sequence number. Every change on the Mac is an envelope
// with a `seq`; a snapshot names the `seq` it already includes. So the list
// applies each envelope once (anything at or before `seq` is skipped), and
// each open transcript keeps its own position and folds only what is newer
// than the snapshot it was built from. Envelopes that arrive while a
// transcript is being fetched wait for it, then fold on top.
//
// The fold itself is the desktop's (`src/lib/transcript.ts`), so a turn reads
// the same on both screens.

import { create } from "zustand";
import {
  applyEvent,
  formatDecisionReply,
  fromDto,
  pushUser,
  resolvePermission,
} from "@egant/lib/transcript";
import type {
  DecisionRequest,
  DecisionResponse,
  PermissionDecision,
  SyncEnvelope,
  TranscriptState,
} from "@egant/lib/types";
import { ApiError, MY_ORIGIN, api } from "./api";
import type { MobileSession, TranscriptWindow } from "./api";

export type Phase = "boot" | "unpaired" | "offline" | "ready";
export type Connection = "connecting" | "live" | "down";

/** A transcript the phone has open. */
export interface LoadedTranscript extends TranscriptState {
  /** Stream position this transcript reflects. */
  seq: number;
  /** Where the loaded entries start in the whole transcript — `0` once the
   * beginning is on screen. */
  start: number;
  loadingOlder: boolean;
}

/** What the stream carries: a change, or word that the phone fell too far
 * behind and should start over from a snapshot. */
export type StreamMessage = SyncEnvelope | { type: "resync" };

interface MobileStore {
  phase: Phase;
  connection: Connection;
  pairError: string | null;
  machineName: string;
  device: { id: string; name: string } | null;
  sessions: MobileSession[];
  epoch: string;
  /** The newest envelope the list has applied. */
  seq: number;
  transcripts: Record<number, LoadedTranscript>;
  transcriptErrors: Record<number, string>;
  /** Decision answers, keyed `${sessionId}:${decisionId}` like the desktop's. */
  decisionResponses: Record<string, DecisionResponse>;
  /** The open conversation, or `null` for the list. */
  openSession: number | null;
  /** A passing problem, shown briefly (a send that failed, say). */
  toast: string | null;

  setConnection: (connection: Connection) => void;
  /** Loads everything from the Mac. False when it could not. */
  refresh: () => Promise<boolean>;
  /** Asks whether the Mac is there and still knows this phone. */
  probe: () => Promise<"ok" | "unpaired" | "unreachable">;
  pair: (code: string) => Promise<boolean>;
  forget: () => Promise<void>;
  receive: (message: StreamMessage) => void;
  openTranscript: (id: number, force?: boolean) => Promise<void>;
  loadOlder: (id: number) => Promise<void>;
  send: (id: number, text: string) => Promise<void>;
  interrupt: (id: number) => Promise<void>;
  answerPermission: (id: number, requestId: string, decision: PermissionDecision) => Promise<void>;
  answerDecision: (id: number, request: DecisionRequest, response: DecisionResponse) => Promise<void>;
  navigate: (session: number | null) => void;
  showToast: (text: string) => void;
  dismissToast: () => void;
}

/** Envelopes for a transcript that is being fetched, held until it lands. */
const loading = new Map<number, SyncEnvelope[]>();

/** Transcripts told to start over while a fetch of them was already out: the
 * snapshot on its way may predate the reason, so they are fetched again. */
const staleWhileLoading = new Set<number>();

/** Envelopes waiting for the next frame: token deltas arrive far faster than
 * a phone should re-render, so they are folded a frame's worth at a time. */
let queue: StreamMessage[] = [];
let flushScheduled = false;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Folds one envelope into an open transcript. */
function foldInto(transcript: LoadedTranscript, envelope: SyncEnvelope): LoadedTranscript {
  const seq = envelope.seq;
  switch (envelope.type) {
    case "harness":
      return { ...(applyEvent(transcript, envelope.payload) as LoadedTranscript), seq };
    case "user_message":
      // This page already showed its own message the moment it was sent.
      if (envelope.origin === MY_ORIGIN) return { ...transcript, seq };
      return { ...(pushUser(transcript, envelope.payload.text) as LoadedTranscript), seq };
    case "permissions": {
      // The table as the Mac now has it, whoever answered: exact, even where
      // an optimistic guess here was not (opencode's Deny ends the turn).
      const { state, pending } = envelope.payload;
      return {
        ...transcript,
        seq,
        state,
        pending: pending[0] ?? null,
        pendingList: pending,
        turnStartedAt: state === "idle" ? null : (transcript.turnStartedAt ?? Date.now()),
      };
    }
    default:
      return { ...transcript, seq };
  }
}

function toLoaded(dto: TranscriptWindow): LoadedTranscript {
  return { ...fromDto(dto), seq: dto.seq, start: dto.start, loadingOlder: false };
}

function toolIndexOf(entries: TranscriptState["entries"]): Record<string, number> {
  const index: Record<string, number> = {};
  entries.forEach((entry, i) => {
    if (entry.kind === "tool") index[entry.id] = i;
  });
  return index;
}

export const useMobile = create<MobileStore>()((set, get) => {
  function patchSession(id: number, patch: Partial<MobileSession>): void {
    set({
      sessions: get().sessions.map((session) =>
        session.id === id ? { ...session, ...patch } : session,
      ),
    });
  }

  /** The Mac's answers to this session's prompts, which win over anything
   * this page guessed. */
  function adoptDecisions(id: number, answers: Record<string, DecisionResponse>): void {
    const entries = Object.entries(answers);
    if (entries.length === 0) return;
    const decisionResponses = { ...get().decisionResponses };
    for (const [decisionId, response] of entries) {
      decisionResponses[`${id}:${decisionId}`] = response;
    }
    set({ decisionResponses });
  }

  function flush(): void {
    flushScheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;

    let { seq, sessions, transcripts, decisionResponses } = get();
    let resync = false;
    const resets = new Set<number>();
    let removedOpen = false;

    for (const item of batch) {
      if (item.type === "resync") {
        resync = true;
        continue;
      }
      const envelope = item;
      // Anything at or before `seq` is already in the list.
      if (envelope.seq <= seq) continue;
      seq = envelope.seq;
      const id = envelope.sessionId;

      switch (envelope.type) {
        case "session": {
          const row = envelope.payload as MobileSession;
          const at = sessions.findIndex((session) => session.id === row.id);
          sessions =
            at >= 0
              ? sessions.map((session, i) => (i === at ? row : session))
              : [...sessions, row];
          break;
        }
        case "session_removed":
          sessions = sessions.filter((session) => session.id !== id);
          if (id != null) {
            const { [id]: _gone, ...rest } = transcripts;
            transcripts = rest;
            if (get().openSession === id) removedOpen = true;
          }
          break;
        case "decision":
          if (id != null) {
            decisionResponses = {
              ...decisionResponses,
              [`${id}:${envelope.payload.decisionId}`]: envelope.payload.response,
            };
          }
          break;
        case "harness":
        case "user_message":
          // Activity is the one row field that moves with every token, so the
          // Mac never re-sends the row for it; the list keeps its own clock.
          if (id != null) {
            sessions = sessions.map((session) =>
              session.id === id ? { ...session, lastActivityMs: envelope.ts } : session,
            );
          }
          break;
        case "transcript_reset":
          if (id != null && loading.has(id)) staleWhileLoading.add(id);
          else if (id != null && transcripts[id]) resets.add(id);
          break;
        default:
          break;
      }

      if (id == null) continue;
      const pending = loading.get(id);
      if (pending) {
        pending.push(envelope);
      } else if (transcripts[id] && envelope.seq > transcripts[id]!.seq) {
        transcripts = { ...transcripts, [id]: foldInto(transcripts[id]!, envelope) };
      }
    }

    set({ seq, sessions, transcripts, decisionResponses });
    if (removedOpen) {
      get().navigate(null);
      get().showToast("That session was closed on your Mac.");
    }
    for (const id of resets) void get().openTranscript(id, true);
    if (resync) {
      void get()
        .refresh()
        .then((ok) => {
          if (!ok) return;
          for (const id of Object.keys(get().transcripts)) void get().openTranscript(Number(id), true);
        });
    }
  }

  return {
    phase: "boot",
    connection: "connecting",
    pairError: null,
    machineName: "",
    device: null,
    sessions: [],
    epoch: "",
    seq: 0,
    transcripts: {},
    transcriptErrors: {},
    decisionResponses: {},
    openSession: sessionFromHash(),
    toast: null,

    setConnection: (connection) => {
      if (get().connection !== connection) set({ connection });
    },

    refresh: async () => {
      try {
        const state = await api.state();
        set({
          phase: "ready",
          machineName: state.machineName,
          device: state.device,
          sessions: state.sessions,
          epoch: state.epoch,
          seq: state.seq,
        });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          set({ phase: "unpaired", connection: "down" });
        } else {
          set({ connection: "down", ...(get().phase === "boot" ? { phase: "offline" } : {}) });
        }
        return false;
      }
    },

    probe: async () => {
      try {
        const health = await api.health();
        if (!health.paired) {
          set({ phase: "unpaired", connection: "down" });
          return "unpaired";
        }
        return "ok";
      } catch {
        return "unreachable";
      }
    },

    pair: async (code) => {
      set({ pairError: null });
      try {
        await api.pair(code);
        return true;
      } catch (error) {
        set({
          phase: "unpaired",
          pairError:
            error instanceof ApiError && error.unreachable
              ? "Can't reach your Mac. Is it awake, with egant open?"
              : message(error),
        });
        return false;
      }
    },

    forget: async () => {
      try {
        await api.unpair();
      } catch {
        // Unreachable or already revoked: forgetting locally is all there is.
      }
      set({
        phase: "unpaired",
        connection: "down",
        sessions: [],
        transcripts: {},
        decisionResponses: {},
        device: null,
        seq: 0,
        epoch: "",
      });
    },

    receive: (item) => {
      queue.push(item);
      if (flushScheduled) return;
      flushScheduled = true;
      // A hidden page gets no animation frames; it still has to keep up.
      if (typeof document !== "undefined" && document.hidden) setTimeout(flush, 200);
      else requestAnimationFrame(flush);
    },

    openTranscript: async (id, force = false) => {
      if (loading.has(id)) return;
      if (!force && get().transcripts[id]) return;
      loading.set(id, []);
      try {
        const dto = await api.transcript(id);
        let transcript = toLoaded(dto);
        for (const envelope of loading.get(id) ?? []) {
          if (envelope.seq > transcript.seq) transcript = foldInto(transcript, envelope);
        }
        const { [id]: _cleared, ...errors } = get().transcriptErrors;
        set({ transcripts: { ...get().transcripts, [id]: transcript }, transcriptErrors: errors });
        adoptDecisions(id, dto.decisionResponses ?? {});
      } catch (error) {
        set({ transcriptErrors: { ...get().transcriptErrors, [id]: message(error) } });
      } finally {
        loading.delete(id);
        if (staleWhileLoading.delete(id)) void get().openTranscript(id, true);
      }
    },

    loadOlder: async (id) => {
      const current = get().transcripts[id];
      if (!current || current.start === 0 || current.loadingOlder) return;
      set({ transcripts: { ...get().transcripts, [id]: { ...current, loadingOlder: true } } });
      try {
        const dto = await api.transcript(id, current.start);
        const older = fromDto(dto).entries;
        const latest = get().transcripts[id];
        if (!latest) return;
        const entries = [...older, ...latest.entries];
        set({
          transcripts: {
            ...get().transcripts,
            [id]: {
              ...latest,
              entries,
              toolIndex: toolIndexOf(entries),
              start: dto.start,
              loadingOlder: false,
            },
          },
        });
        adoptDecisions(id, dto.decisionResponses ?? {});
      } catch (error) {
        const latest = get().transcripts[id];
        if (latest) {
          set({ transcripts: { ...get().transcripts, [id]: { ...latest, loadingOlder: false } } });
        }
        get().showToast(message(error));
      }
    },

    send: async (id, text) => {
      if (!text.trim()) return;
      // Echoed at once, the way the desktop does; the Mac's copy of the same
      // message comes back tagged as this page's and is skipped.
      const transcript = get().transcripts[id];
      if (transcript) {
        set({
          transcripts: {
            ...get().transcripts,
            [id]: pushUser(transcript, text) as LoadedTranscript,
          },
        });
      }
      patchSession(id, { busy: true, state: "running", lastActivityMs: Date.now() });
      try {
        const reply = await api.send(id, text);
        if (reply.title) patchSession(id, { title: reply.title });
      } catch (error) {
        get().showToast(message(error));
        // The echo above may not have happened on the Mac: take its word.
        void get().openTranscript(id, true);
      }
    },

    interrupt: async (id) => {
      try {
        await api.interrupt(id);
      } catch (error) {
        get().showToast(message(error));
      }
    },

    answerPermission: async (id, requestId, decision) => {
      const transcript = get().transcripts[id];
      if (transcript) {
        set({
          transcripts: {
            ...get().transcripts,
            [id]: resolvePermission(transcript, requestId) as LoadedTranscript,
          },
        });
      }
      try {
        const reply = await api.answerPermission(id, requestId, decision);
        if (reply.permissionMode) patchSession(id, { permissionMode: reply.permissionMode });
      } catch (error) {
        get().showToast(message(error));
        void get().openTranscript(id, true);
      }
    },

    answerDecision: async (id, request, response) => {
      const key = `${id}:${request.id}`;
      if (get().decisionResponses[key]) return;
      const text = formatDecisionReply(request, response);
      const transcript = get().transcripts[id];
      set({
        decisionResponses: { ...get().decisionResponses, [key]: response },
        ...(transcript
          ? {
              transcripts: {
                ...get().transcripts,
                [id]: pushUser(transcript, text) as LoadedTranscript,
              },
            }
          : {}),
      });
      patchSession(id, { busy: true, state: "running", lastActivityMs: Date.now() });
      try {
        const reply = await api.answerDecision(id, request.id, response, text);
        if (reply.title) patchSession(id, { title: reply.title });
      } catch (error) {
        const { [key]: _mine, ...rest } = get().decisionResponses;
        set({ decisionResponses: rest });
        get().showToast(
          error instanceof ApiError && error.status === 409
            ? "That was already answered on another device."
            : message(error),
        );
        void get().openTranscript(id, true);
      }
    },

    navigate: (session) => {
      if (session === get().openSession) return;
      if (session == null) {
        // Back to the list: step back through history when the list is what
        // is behind this page, so the phone's own back gesture stays in step.
        if (window.history.state?.egantSession != null) window.history.back();
        else window.history.replaceState({}, "", "#/");
      } else {
        window.history.pushState({ egantSession: session }, "", `#/s/${session}`);
      }
      set({ openSession: session });
    },

    showToast: (text) => set({ toast: text }),
    dismissToast: () => set({ toast: null }),
  };
});

function sessionFromHash(): number | null {
  const match = /^#\/s\/(\d+)$/.exec(window.location.hash);
  return match ? Number(match[1]) : null;
}

// The phone's back gesture (and the browser's back button) walks the same
// history `navigate` writes.
window.addEventListener("popstate", () => {
  useMobile.setState({ openSession: sessionFromHash() });
});
